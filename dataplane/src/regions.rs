use std::{
    collections::{BTreeMap, BTreeSet},
    env,
};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use url::Url;

pub(crate) const DEFAULT_STORAGE_REGION: &str = "eu-central";
pub(crate) const DEFAULT_BACKEND_ID: &str = "primary";

/// Credentials and endpoint details for one physical S3-compatible backend.
///
/// This type intentionally does not implement `Debug`: an accidentally logged
/// registry must never print provider application keys.
#[derive(Clone)]
pub(crate) struct StorageBackend {
    pub(crate) endpoint_scheme: String,
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    pub(crate) access_key_id: String,
    pub(crate) secret_access_key: String,
    pub(crate) signing_region: String,
    pub(crate) force_path_style: bool,
}

#[derive(Clone)]
struct LogicalRegionStorage {
    backends: BTreeMap<String, StorageBackend>,
}

#[derive(Clone)]
pub(crate) struct RegionRegistry {
    local_region: String,
    storage: BTreeMap<String, LogicalRegionStorage>,
    failover_regions: BTreeSet<String>,
    ingress_domains: BTreeMap<String, String>,
    peers: BTreeMap<String, Url>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum LogicalRegionInput {
    Single(StorageBackendInput),
    Expanded(ExpandedRegionInput),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpandedRegionInput {
    #[serde(default = "default_backend_id")]
    default_backend: String,
    backends: BTreeMap<String, StorageBackendInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageBackendInput {
    endpoint: String,
    #[serde(default = "default_endpoint_scheme")]
    endpoint_scheme: String,
    #[serde(alias = "bucketName")]
    bucket: String,
    #[serde(alias = "accessKey")]
    access_key_id: String,
    #[serde(alias = "secretKey")]
    secret_access_key: String,
    #[serde(default = "default_signing_region", alias = "region")]
    signing_region: String,
    #[serde(default)]
    force_path_style: bool,
}

impl RegionRegistry {
    pub(crate) fn from_env(s3_domain: &str) -> Result<Self> {
        let local_region =
            env::var("DATAPLANE_REGION").unwrap_or_else(|_| DEFAULT_STORAGE_REGION.to_string());
        validate_id("storage region", &local_region)?;

        let storage = match env::var("DATAPLANE_STORAGE_REGIONS") {
            Ok(raw) if !raw.trim().is_empty() => parse_storage_registry(&raw)?,
            _ => legacy_storage_registry(&local_region)?,
        };
        if !storage.contains_key(&local_region) {
            return Err(anyhow!(
                "DATAPLANE_REGION {local_region} is missing from DATAPLANE_STORAGE_REGIONS"
            ));
        }

        let failover_regions = parse_failover_regions(
            &env::var("DATAPLANE_FAILOVER_REGIONS").unwrap_or_default(),
            &storage,
        )?;
        if failover_regions.contains(&local_region) {
            return Err(anyhow!(
                "DATAPLANE_FAILOVER_REGIONS must not include local DATAPLANE_REGION {local_region}"
            ));
        }
        let ingress_domains = parse_ingress_domains(
            env::var("DATAPLANE_INGRESS_DOMAINS").ok().as_deref(),
            s3_domain,
        )?;
        let peers = parse_region_peers(
            env::var("DATAPLANE_REGION_PEERS").ok().as_deref(),
            &local_region,
            &ingress_domains,
        )?;

        Ok(Self {
            local_region,
            storage,
            failover_regions,
            ingress_domains,
            peers,
        })
    }

    pub(crate) fn local_region(&self) -> &str {
        &self.local_region
    }

    pub(crate) fn backend(&self, region: &str, backend_id: &str) -> Result<&StorageBackend> {
        self.ensure_served(region)?;
        self.configured_backend(region, backend_id).ok_or_else(|| {
            anyhow!("storage backend {backend_id} for region {region} is not configured")
        })
    }

    pub(crate) fn configured_backend(
        &self,
        region: &str,
        backend_id: &str,
    ) -> Option<&StorageBackend> {
        self.storage
            .get(region)
            .and_then(|region| region.backends.get(backend_id))
    }

    pub(crate) fn ensure_served(&self, region: &str) -> Result<()> {
        validate_id("storage region", region)?;
        if !self.storage.contains_key(region) {
            return Err(anyhow!("storage region {region} is not configured"));
        }
        if region != self.local_region && !self.failover_regions.contains(region) {
            return Err(anyhow!(
                "remote storage region {region} is not authorized for failover on {}",
                self.local_region
            ));
        }
        Ok(())
    }

    pub(crate) fn is_local(&self, region: &str) -> bool {
        region == self.local_region
    }

    pub(crate) fn is_failover(&self, region: &str) -> bool {
        region != self.local_region && self.failover_regions.contains(region)
    }

    pub(crate) fn served_regions(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.local_region.as_str())
            .chain(self.failover_regions.iter().map(String::as_str))
    }

    pub(crate) fn configured_regions(&self) -> impl Iterator<Item = &str> {
        self.storage.keys().map(String::as_str)
    }

    pub(crate) fn configured_backends(
        &self,
        region: &str,
    ) -> impl Iterator<Item = (&str, &StorageBackend)> {
        self.storage
            .get(region)
            .into_iter()
            .flat_map(|storage| storage.backends.iter())
            .map(|(id, backend)| (id.as_str(), backend))
    }

    pub(crate) fn ingress_region(&self, host: Option<&str>) -> &str {
        let Some(host) = host else {
            return "unknown";
        };
        let host = host_without_port(host).to_ascii_lowercase();
        self.ingress_domains
            .get(&host)
            .map(String::as_str)
            .unwrap_or("custom")
    }

    pub(crate) fn ingress_domains(&self) -> impl Iterator<Item = &str> {
        self.ingress_domains.keys().map(String::as_str)
    }

    pub(crate) fn peer(&self, region: &str) -> Option<&Url> {
        self.peers.get(region)
    }

    pub(crate) fn preferred_ingress_domain<'a>(
        &'a self,
        region: &str,
        default_domain: &'a str,
    ) -> Option<&'a str> {
        if region == DEFAULT_STORAGE_REGION {
            return Some(default_domain);
        }
        self.ingress_domains
            .iter()
            .filter(|(domain, mapped)| {
                *mapped == region && !is_private_origin_domain(domain.as_str())
            })
            .min_by_key(|(domain, _)| (domain.matches('.').count(), domain.len()))
            .map(|(domain, _)| domain.as_str())
    }
}

fn is_private_origin_domain(domain: &str) -> bool {
    let first_label = domain.split('.').next().unwrap_or(domain);
    first_label == "origin"
        || first_label.ends_with("-origin")
        || first_label.starts_with("origin-")
}

fn parse_storage_registry(raw: &str) -> Result<BTreeMap<String, LogicalRegionStorage>> {
    let parsed: BTreeMap<String, LogicalRegionInput> = serde_json::from_str(raw)
        .context("DATAPLANE_STORAGE_REGIONS must be a JSON object keyed by region ID")?;
    if parsed.is_empty() {
        return Err(anyhow!("DATAPLANE_STORAGE_REGIONS must not be empty"));
    }

    parsed
        .into_iter()
        .map(|(region_id, input)| {
            validate_id("storage region", &region_id)?;
            let region = match input {
                LogicalRegionInput::Single(input) => LogicalRegionStorage {
                    backends: BTreeMap::from([(
                        DEFAULT_BACKEND_ID.to_string(),
                        normalize_backend(input)?,
                    )]),
                },
                LogicalRegionInput::Expanded(input) => {
                    validate_id("storage backend", &input.default_backend)?;
                    if input.backends.is_empty() {
                        return Err(anyhow!(
                            "storage region {region_id} must configure at least one backend"
                        ));
                    }
                    let backends = input
                        .backends
                        .into_iter()
                        .map(|(backend_id, backend)| {
                            validate_id("storage backend", &backend_id)?;
                            Ok((backend_id, normalize_backend(backend)?))
                        })
                        .collect::<Result<BTreeMap<_, _>>>()?;
                    if !backends.contains_key(&input.default_backend) {
                        return Err(anyhow!(
                            "defaultBackend {} is not configured for region {region_id}",
                            input.default_backend
                        ));
                    }
                    LogicalRegionStorage { backends }
                }
            };
            Ok((region_id, region))
        })
        .collect()
}

fn normalize_backend(input: StorageBackendInput) -> Result<StorageBackend> {
    let mut endpoint_scheme = input.endpoint_scheme.to_ascii_lowercase();
    let mut endpoint = input.endpoint.trim().trim_end_matches('/').to_string();
    if endpoint.contains("://") {
        let parsed = Url::parse(&endpoint).context("storage backend endpoint is invalid")?;
        let parsed_scheme = parsed.scheme().to_ascii_lowercase();
        if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(anyhow!(
                "storage backend endpoint must not contain a path or query"
            ));
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(anyhow!(
                "storage backend endpoint must not contain credentials"
            ));
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| anyhow!("storage backend endpoint is missing a host"))?;
        endpoint = match parsed.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        endpoint_scheme = parsed_scheme;
    }
    if !matches!(endpoint_scheme.as_str(), "http" | "https") {
        return Err(anyhow!(
            "storage backend endpointScheme must be http or https"
        ));
    }
    if endpoint.is_empty() || endpoint.contains('/') || endpoint.chars().any(char::is_whitespace) {
        return Err(anyhow!(
            "storage backend endpoint must be a host with optional port"
        ));
    }
    if input.bucket.is_empty()
        || input.bucket.contains('.')
        || !input
            .bucket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(anyhow!(
            "storage backend bucket must contain only ASCII letters, digits, and hyphens"
        ));
    }
    if input.access_key_id.is_empty() || input.secret_access_key.is_empty() {
        return Err(anyhow!("storage backend credentials must not be empty"));
    }
    if input.signing_region.is_empty() || input.signing_region.chars().any(char::is_whitespace) {
        return Err(anyhow!("storage backend signingRegion is invalid"));
    }

    Ok(StorageBackend {
        endpoint_scheme,
        endpoint,
        bucket: input.bucket,
        access_key_id: input.access_key_id,
        secret_access_key: input.secret_access_key,
        signing_region: input.signing_region,
        force_path_style: input.force_path_style,
    })
}

fn legacy_storage_registry(local_region: &str) -> Result<BTreeMap<String, LogicalRegionStorage>> {
    let input = StorageBackendInput {
        endpoint: env::var("S3_ENDPOINT")
            .context("S3_ENDPOINT is required when DATAPLANE_STORAGE_REGIONS is not configured")?,
        endpoint_scheme: env::var("S3_ENDPOINT_SCHEME").unwrap_or_else(|_| "https".into()),
        bucket: env::var("S3_BUCKET_NAME").context(
            "S3_BUCKET_NAME is required when DATAPLANE_STORAGE_REGIONS is not configured",
        )?,
        access_key_id: env::var("S3_ACCESS_KEY_ID").context(
            "S3_ACCESS_KEY_ID is required when DATAPLANE_STORAGE_REGIONS is not configured",
        )?,
        secret_access_key: env::var("S3_SECRET_ACCESS_KEY").context(
            "S3_SECRET_ACCESS_KEY is required when DATAPLANE_STORAGE_REGIONS is not configured",
        )?,
        signing_region: env::var("S3_REGION").unwrap_or_else(|_| "auto".into()),
        force_path_style: false,
    };
    Ok(BTreeMap::from([(
        local_region.to_string(),
        LogicalRegionStorage {
            backends: BTreeMap::from([(DEFAULT_BACKEND_ID.to_string(), normalize_backend(input)?)]),
        },
    )]))
}

fn parse_failover_regions(
    raw: &str,
    storage: &BTreeMap<String, LogicalRegionStorage>,
) -> Result<BTreeSet<String>> {
    raw.split(',')
        .map(str::trim)
        .filter(|region| !region.is_empty())
        .map(|region| {
            validate_id("storage region", region)?;
            if !storage.contains_key(region) {
                return Err(anyhow!(
                    "DATAPLANE_FAILOVER_REGIONS contains unconfigured region {region}"
                ));
            }
            Ok(region.to_string())
        })
        .collect()
}

fn parse_ingress_domains(raw: Option<&str>, s3_domain: &str) -> Result<BTreeMap<String, String>> {
    let domains = if let Some(raw) = raw.filter(|value| !value.trim().is_empty()) {
        serde_json::from_str::<BTreeMap<String, String>>(raw)
            .context("DATAPLANE_INGRESS_DOMAINS must be a JSON object mapping host to region ID")?
    } else {
        let base = host_without_port(s3_domain).to_ascii_lowercase();
        BTreeMap::from([
            (base.clone(), DEFAULT_STORAGE_REGION.to_string()),
            (format!("eu.{base}"), DEFAULT_STORAGE_REGION.to_string()),
            (format!("us.{base}"), "us-east".to_string()),
        ])
    };
    let mut normalized = BTreeMap::new();
    for (domain, region) in domains {
        validate_id("storage region", &region)?;
        let domain = host_without_port(domain.trim()).to_ascii_lowercase();
        if domain.is_empty() || domain.contains('/') || domain.chars().any(char::is_whitespace) {
            return Err(anyhow!(
                "DATAPLANE_INGRESS_DOMAINS contains an invalid host"
            ));
        }
        normalized.insert(domain, region);
    }
    Ok(normalized)
}

fn parse_region_peers(
    raw: Option<&str>,
    local_region: &str,
    ingress_domains: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, Url>> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(BTreeMap::new());
    };
    let peers = serde_json::from_str::<BTreeMap<String, String>>(raw)
        .context("DATAPLANE_REGION_PEERS must be a JSON object mapping region ID to origin")?;
    peers
        .into_iter()
        .map(|(region, origin)| {
            validate_id("storage region", &region)?;
            if region == local_region || !ingress_domains.values().any(|known| known == &region) {
                return Err(anyhow!(
                    "DATAPLANE_REGION_PEERS may only name known remote ingress regions"
                ));
            }
            let mut url = Url::parse(origin.trim()).context("dataplane peer origin is invalid")?;
            let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
            if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                return Err(anyhow!("dataplane peer origins must use HTTPS"));
            }
            if !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path() != "/"
            {
                return Err(anyhow!(
                    "dataplane peer origin must not contain credentials, path, query, or fragment"
                ));
            }
            url.set_path("");
            Ok((region, url))
        })
        .collect()
}

fn host_without_port(host: &str) -> &str {
    host.rsplit_once(':')
        .filter(|(_, port)| port.bytes().all(|byte| byte.is_ascii_digit()))
        .map(|(host, _)| host)
        .unwrap_or(host)
}

fn validate_id(kind: &str, value: &str) -> Result<()> {
    if !(2..=63).contains(&value.len())
        || value == "auto"
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (byte == b'-' && index > 0 && index + 1 < value.len())
        })
    {
        return Err(anyhow!(
            "invalid {kind} ID {value:?}; use lowercase letters, digits, and interior hyphens"
        ));
    }
    Ok(())
}

fn default_endpoint_scheme() -> String {
    "https".into()
}

fn default_signing_region() -> String {
    "auto".into()
}

fn default_backend_id() -> String {
    DEFAULT_BACKEND_ID.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_json() -> &'static str {
        r#"{
          "eu-central": {
            "endpoint": "https://s3.eu.example.test",
            "bucket": "silo-eu",
            "accessKeyId": "eu-key",
            "secretAccessKey": "eu-secret",
            "signingRegion": "auto"
          },
          "us-east": {
            "defaultBackend": "b2",
            "backends": {
              "b2": {
                "endpoint": "s3.us.example.test",
                "endpointScheme": "https",
                "bucket": "silo-us",
                "accessKeyId": "us-key",
                "secretAccessKey": "us-secret"
              },
              "replica": {
                "endpoint": "s3.replica.example.test",
                "bucket": "silo-us-replica",
                "accessKeyId": "replica-key",
                "secretAccessKey": "replica-secret"
              }
            }
          }
        }"#
    }

    #[test]
    fn single_backend_is_backward_compatible_shorthand() {
        let storage = parse_storage_registry(registry_json()).unwrap();
        assert!(storage["eu-central"].backends.contains_key("primary"));
        assert_eq!(storage["eu-central"].backends["primary"].bucket, "silo-eu");
    }

    #[test]
    fn expanded_registry_keeps_provider_backends_independent() {
        let storage = parse_storage_registry(registry_json()).unwrap();
        assert!(storage["us-east"].backends.contains_key("b2"));
        assert_eq!(storage["us-east"].backends["b2"].bucket, "silo-us");
        assert_eq!(
            storage["us-east"].backends["replica"].bucket,
            "silo-us-replica"
        );
    }

    #[test]
    fn failover_activation_is_explicit_and_configured() {
        let storage = parse_storage_registry(registry_json()).unwrap();
        let active = parse_failover_regions("us-east", &storage).unwrap();
        assert!(active.contains("us-east"));
        assert!(parse_failover_regions("ap-south", &storage).is_err());
    }

    #[test]
    fn rejects_auto_and_unsafe_endpoints() {
        assert!(validate_id("storage region", "auto").is_err());
        assert!(validate_id("storage region", "US-east").is_err());
        let bad = r#"{
          "eu-central": {
            "endpoint": "https://s3.example.test/path",
            "bucket": "silo-eu",
            "accessKeyId": "key",
            "secretAccessKey": "secret"
          }
        }"#;
        assert!(parse_storage_registry(bad).is_err());
    }

    #[test]
    fn every_regional_public_endpoint_is_an_ingress_origin() {
        let ingress = parse_ingress_domains(None, "onsilo.dev").unwrap();
        assert_eq!(
            ingress.get("onsilo.dev").map(String::as_str),
            Some("eu-central")
        );
        assert_eq!(
            ingress.get("eu.onsilo.dev").map(String::as_str),
            Some("eu-central")
        );
        assert_eq!(
            ingress.get("us.onsilo.dev").map(String::as_str),
            Some("us-east")
        );
    }

    #[test]
    fn provider_path_style_is_explicit() {
        let raw = registry_json().replace(
            "\"signingRegion\": \"auto\"",
            "\"signingRegion\": \"auto\", \"forcePathStyle\": true",
        );
        let storage = parse_storage_registry(&raw).unwrap();
        assert!(storage["eu-central"].backends["primary"].force_path_style);
        assert!(!storage["us-east"].backends["b2"].force_path_style);
    }

    #[test]
    fn peers_are_fixed_https_origins_for_remote_regions() {
        let ingress = parse_ingress_domains(None, "onsilo.dev").unwrap();
        let peers = parse_region_peers(
            Some(r#"{"us-east":"https://us-origin.example.test"}"#),
            "eu-central",
            &ingress,
        )
        .unwrap();
        assert_eq!(peers["us-east"].as_str(), "https://us-origin.example.test/");
        assert!(parse_region_peers(
            Some(r#"{"us-east":"http://us-origin.example.test"}"#),
            "eu-central",
            &ingress,
        )
        .is_err());
        assert!(parse_region_peers(
            Some(r#"{"eu-central":"https://eu-origin.example.test"}"#),
            "eu-central",
            &ingress,
        )
        .is_err());
    }

    #[test]
    fn peer_routing_does_not_require_remote_provider_credentials() {
        let local_only = parse_storage_registry(
            r#"{"eu-central":{"endpoint":"s3.eu.example.test","bucket":"silo-eu","accessKeyId":"key","secretAccessKey":"secret"}}"#,
        )
        .unwrap();
        assert!(!local_only.contains_key("us-east"));
        let ingress = parse_ingress_domains(None, "onsilo.dev").unwrap();
        let peers = parse_region_peers(
            Some(r#"{"us-east":"https://us-origin.example.test"}"#),
            "eu-central",
            &ingress,
        )
        .unwrap();
        assert!(peers.contains_key("us-east"));
    }

    #[test]
    fn preferred_endpoint_never_leaks_private_origin_host() {
        let registry = RegionRegistry {
            local_region: "eu-central".to_string(),
            storage: parse_storage_registry(registry_json()).unwrap(),
            failover_regions: BTreeSet::new(),
            ingress_domains: BTreeMap::from([
                ("onsilo.dev".to_string(), "eu-central".to_string()),
                ("us-origin.onsilo.dev".to_string(), "us-east".to_string()),
                ("us.onsilo.dev".to_string(), "us-east".to_string()),
            ]),
            peers: BTreeMap::new(),
        };
        assert_eq!(
            registry.preferred_ingress_domain("eu-central", "onsilo.dev"),
            Some("onsilo.dev")
        );
        assert_eq!(
            registry.preferred_ingress_domain("us-east", "onsilo.dev"),
            Some("us.onsilo.dev")
        );
    }
}
