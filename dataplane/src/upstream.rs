use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use axum::http::{HeaderMap, Method};
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use url::Url;

use crate::{regions::StorageBackend, AppState, AuthBucket};

type HmacSha256 = Hmac<Sha256>;

pub(crate) fn signed_upstream_request(
    state: &AppState,
    bucket: &AuthBucket,
    method: Method,
    path_with_query: &str,
    incoming_headers: &HeaderMap,
    content_length: Option<u64>,
) -> Result<reqwest::RequestBuilder> {
    let backend = bucket.active_backend()?;
    signed_backend_request(
        state,
        &bucket.resolved_region,
        &backend.id,
        method,
        path_with_query,
        incoming_headers,
        content_length,
    )
}

pub(crate) fn signed_backend_request(
    state: &AppState,
    storage_region: &str,
    backend_id: &str,
    method: Method,
    path_with_query: &str,
    incoming_headers: &HeaderMap,
    content_length: Option<u64>,
) -> Result<reqwest::RequestBuilder> {
    let storage = state.cfg.regions.backend(storage_region, backend_id)?;
    let url = upstream_url(storage, path_with_query)?;
    let mut headers = filtered_upstream_headers(incoming_headers);
    headers.insert("host".into(), request_host(storage));
    headers.insert("x-amz-content-sha256".into(), "UNSIGNED-PAYLOAD".into());
    if let Some(len) = content_length {
        headers.insert("content-length".into(), len.to_string());
    }
    if headers
        .get("content-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("aws-chunked"))
    {
        headers.remove("content-encoding");
    }

    sign_headers(
        state,
        storage_region,
        backend_id,
        storage,
        method.as_str(),
        &url,
        &mut headers,
    )?;

    let mut builder = state.http.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes())?,
        url,
    );
    for (k, v) in headers {
        builder = builder.header(k, v);
    }
    Ok(builder)
}

fn upstream_url(storage: &StorageBackend, path_with_query: &str) -> Result<Url> {
    let host = request_host(storage);
    let bucket_prefix = if storage.force_path_style {
        format!("{}/", storage.bucket)
    } else {
        String::new()
    };
    let url = if let Some((path, query)) = path_with_query.split_once('?') {
        format!(
            "{}://{host}/{bucket_prefix}{}?{query}",
            storage.endpoint_scheme,
            encode_s3_path(path)
        )
    } else {
        format!(
            "{}://{host}/{bucket_prefix}{}",
            storage.endpoint_scheme,
            encode_s3_path(path_with_query)
        )
    };
    Ok(Url::parse(&url)?)
}

fn request_host(storage: &StorageBackend) -> String {
    if storage.force_path_style {
        storage.endpoint.clone()
    } else {
        format!("{}.{}", storage.bucket, storage.endpoint)
    }
}

fn encode_s3_path(path: &str) -> String {
    path.trim_start_matches('/')
        .split('/')
        .map(preserve_pct_encoded_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn preserve_pct_encoded_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            out.push('%');
            out.push((bytes[i + 1] as char).to_ascii_uppercase());
            out.push((bytes[i + 2] as char).to_ascii_uppercase());
            i += 3;
            continue;
        }

        let ch = segment[i..].chars().next().expect("valid char boundary");
        if ch == ' ' {
            out.push_str("%20");
        } else {
            for encoded in url::form_urlencoded::byte_serialize(ch.to_string().as_bytes()) {
                out.push_str(encoded);
            }
        }
        i += ch.len_utf8();
    }
    out
}

fn filtered_upstream_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    let allow = [
        "content-type",
        "content-length",
        "content-md5",
        "cache-control",
        "content-disposition",
        "content-encoding",
        "content-language",
        "expires",
        "range",
        "if-match",
        "if-none-match",
        "if-modified-since",
        "if-unmodified-since",
        "x-amz-tagging",
        "x-amz-storage-class",
        "x-amz-copy-source",
        "x-amz-copy-source-if-match",
        "x-amz-copy-source-if-none-match",
        "x-amz-copy-source-if-modified-since",
        "x-amz-copy-source-if-unmodified-since",
        "x-amz-metadata-directive",
        "x-amz-tagging-directive",
        "x-amz-website-redirect-location",
        "x-amz-server-side-encryption",
    ];
    headers
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str().to_ascii_lowercase();
            if allow.contains(&name.as_str()) || name.starts_with("x-amz-meta-") {
                v.to_str().ok().map(|value| (name, value.to_string()))
            } else {
                None
            }
        })
        .collect()
}

fn sign_headers(
    state: &AppState,
    storage_region: &str,
    backend_id: &str,
    storage: &StorageBackend,
    method: &str,
    url: &Url,
    headers: &mut BTreeMap<String, String>,
) -> Result<()> {
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    headers.insert("x-amz-date".into(), amz_date.clone());

    let canonical_uri = if url.path().is_empty() {
        "/"
    } else {
        url.path()
    };
    let canonical_query = canonical_query(url);
    let signed_headers = headers
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = headers
        .iter()
        .map(|(k, v)| {
            format!(
                "{}:{}\n",
                k.to_ascii_lowercase(),
                v.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        })
        .collect::<String>();

    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\nUNSIGNED-PAYLOAD"
    );
    let canonical_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    let scope = format!("{}/{}/s3/aws4_request", date_stamp, storage.signing_region);
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{canonical_hash}");
    let signing_key = cached_signing_key(
        state,
        storage_region,
        backend_id,
        storage,
        &date_stamp,
        "s3",
    )?;
    let mut mac = HmacSha256::new_from_slice(&signing_key)?;
    mac.update(string_to_sign.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());

    headers.insert(
        "authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            storage.access_key_id, scope, signed_headers, signature
        ),
    );
    Ok(())
}

fn cached_signing_key(
    state: &AppState,
    storage_region: &str,
    backend_id: &str,
    storage: &StorageBackend,
    date_stamp: &str,
    service: &str,
) -> Result<Vec<u8>> {
    let cache_key = format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        storage_region,
        backend_id,
        storage.access_key_id,
        date_stamp,
        storage.signing_region,
        service
    );
    if let Some(key) = state
        .signing_keys
        .read()
        .map_err(|_| anyhow!("signing key cache poisoned"))?
        .get(&cache_key)
        .cloned()
    {
        return Ok(key);
    }

    let key = signing_key(
        &storage.secret_access_key,
        date_stamp,
        &storage.signing_region,
        service,
    )?;
    state
        .signing_keys
        .write()
        .map_err(|_| anyhow!("signing key cache poisoned"))?
        .insert(cache_key, key.clone());
    Ok(key)
}

fn canonical_query(url: &Url) -> String {
    let mut pairs = url
        .query_pairs()
        .map(|(k, v)| (uri_encode(&k), uri_encode(&v)))
        .collect::<Vec<_>>();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn uri_encode(input: &str) -> String {
    url::form_urlencoded::byte_serialize(input.as_bytes())
        .collect::<String>()
        .replace("+", "%20")
        .replace("%7E", "~")
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Result<Vec<u8>> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, service.as_bytes())?;
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key)?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}
