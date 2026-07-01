use crate::AuthorizeResponse;

pub(crate) fn authorized_path_is_jailed(auth: &AuthorizeResponse) -> bool {
    let Some(path_with_query) = auth.path_with_query.as_deref() else {
        return false;
    };
    let Some(root_prefix) = auth.root_prefix.as_deref() else {
        return false;
    };

    let path = path_with_query
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(path_with_query)
        .trim_start_matches('/');
    let root = root_prefix.trim_start_matches('/');

    !path.contains('\\')
        && !root.is_empty()
        && (path == root.trim_end_matches('/') || path.starts_with(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_for_path(path_with_query: &str, root_prefix: &str) -> AuthorizeResponse {
        AuthorizeResponse {
            allowed: true,
            status: None,
            body: None,
            fast_path: Some(true),
            action: Some("GetObject".to_string()),
            key: Some("file.txt".to_string()),
            path_with_query: Some(path_with_query.to_string()),
            root_prefix: Some(root_prefix.to_string()),
            part_number: None,
            upload_id: None,
            cors_headers: None,
            bucket: None,
            user: None,
        }
    }

    #[test]
    fn jail_allows_only_exact_bucket_prefix() {
        assert!(authorized_path_is_jailed(&auth_for_path(
            "users/u1/photos/a.jpg?x=1",
            "users/u1/photos/",
        )));
        assert!(authorized_path_is_jailed(&auth_for_path(
            "users/u1/photos/",
            "users/u1/photos/",
        )));
        assert!(!authorized_path_is_jailed(&auth_for_path(
            "users/u1/photos2/a.jpg",
            "users/u1/photos/",
        )));
        assert!(!authorized_path_is_jailed(&auth_for_path(
            "users/u1/photos\\a.jpg",
            "users/u1/photos/",
        )));
    }
}
