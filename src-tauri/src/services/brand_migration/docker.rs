//! Docker: the containers and the stock image an older build left behind.
//!
//! Lazy, at the moments the sandbox code talks to Docker anyway — it is
//! never started or probed for the migration's sake. Containers are swept
//! under either owner label (a previous run's containers are stale by
//! definition). The stock image is given its current name with `docker tag`,
//! which only adds a name to the same image id: nothing is rebuilt, and the
//! old tag stays for an older build until a later release removes it.

use crate::brand::{Name, Pair};

/// The owner labels (`key=value`) the sweep filters by: the current one,
/// then the one an older build put on its containers.
pub fn owner_labels(pair: &Pair) -> Vec<String> {
    let mut labels = vec![pair.cur(Name::DOCKER_OWNER_LABEL)];
    labels.extend(pair.legacy(Name::DOCKER_OWNER_LABEL));
    labels
}

/// Note that the sweep found containers under the old owner label.
pub fn swept_legacy(pair: &Pair, label: &str) {
    if pair.legacy(Name::DOCKER_OWNER_LABEL).as_deref() == Some(label) {
        crate::brand::legacy_hit("docker-labels");
    }
}

/// When `image` is the stock sandbox image under its current name and only
/// the old name exists locally, tag the old one as the current. `exists` and
/// `tag` are the Docker calls. Returns whether `image` exists afterwards.
pub fn adopt_legacy_image(
    pair: &Pair,
    image: &str,
    exists: impl Fn(&str) -> bool,
    tag: impl Fn(&str, &str) -> bool,
) -> bool {
    if exists(image) {
        return true;
    }
    let Some(old) = pair.legacy(Name::SANDBOX_IMAGE) else {
        return false;
    };
    if image != pair.cur(Name::SANDBOX_IMAGE) || !exists(&old) {
        return false;
    }
    crate::brand::legacy_hit("docker-image");
    let tagged = tag(&old, image) && exists(image);
    if tagged {
        super::lazy_done(pair, &crate::storage::state_dir(), "docker-image", "the old image was tagged with the current name");
    }
    tagged
}

#[cfg(test)]
mod tests {
    use super::super::hits;
    use super::super::testing::{RENAMED, UNCHANGED};
    use super::*;
    use crate::brand::LEGACY;
    use std::cell::RefCell;
    use std::collections::BTreeSet;

    struct FakeDocker {
        images: RefCell<BTreeSet<String>>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeDocker {
        fn with(images: &[&str]) -> Self {
            Self {
                images: RefCell::new(images.iter().map(|i| i.to_string()).collect()),
                calls: RefCell::new(Vec::new()),
            }
        }
        fn adopt(&self, pair: &Pair, image: &str) -> bool {
            adopt_legacy_image(
                pair,
                image,
                |image| {
                    self.calls.borrow_mut().push(format!("exists {image}"));
                    self.images.borrow().contains(image)
                },
                |from, to| {
                    self.calls.borrow_mut().push(format!("tag {from} {to}"));
                    self.images.borrow_mut().insert(to.to_string());
                    true
                },
            )
        }
    }

    #[test]
    fn the_sweep_filters_by_both_owner_labels_once_renamed() {
        assert_eq!(
            owner_labels(&RENAMED),
            ["newname.owner=newname".to_string(), LEGACY.name(Name::DOCKER_OWNER_LABEL)]
        );
        let _ = hits::taken();
        swept_legacy(&RENAMED, "newname.owner=newname");
        assert!(hits::taken().is_empty());
        swept_legacy(&RENAMED, &LEGACY.name(Name::DOCKER_OWNER_LABEL));
        assert_eq!(hits::taken(), ["docker-labels"]);
        assert_eq!(owner_labels(&UNCHANGED), [crate::brand::DOCKER_OWNER_LABEL.to_string()]);
    }

    #[test]
    fn the_old_stock_image_is_tagged_not_rebuilt() {
        let old = LEGACY.name(Name::SANDBOX_IMAGE);
        let new = RENAMED.cur(Name::SANDBOX_IMAGE);
        let docker = FakeDocker::with(&[&old]);
        let _ = hits::taken();
        assert!(docker.adopt(&RENAMED, &new));
        assert_eq!(hits::taken_here(), ["docker-image"]);
        assert!(docker.images.borrow().contains(&new) && docker.images.borrow().contains(&old));
        assert!(docker.calls.borrow().contains(&format!("tag {old} {new}")));
        // Present now: no second tag.
        docker.calls.borrow_mut().clear();
        assert!(docker.adopt(&RENAMED, &new));
        assert_eq!(*docker.calls.borrow(), [format!("exists {new}")]);
    }

    #[test]
    fn only_the_stock_image_is_adopted() {
        let old = LEGACY.name(Name::SANDBOX_IMAGE);
        let docker = FakeDocker::with(&[&old]);
        assert!(!docker.adopt(&RENAMED, "python:3.12"));
        assert!(!docker.adopt(&RENAMED, "newname-p1:latest"));
        assert!(!docker.calls.borrow().iter().any(|call| call.starts_with("tag")));
        // Neither name exists: nothing to adopt.
        assert!(!FakeDocker::with(&[]).adopt(&RENAMED, &RENAMED.cur(Name::SANDBOX_IMAGE)));
    }

    #[test]
    fn the_unchanged_pair_asks_docker_once() {
        let docker = FakeDocker::with(&[]);
        assert!(!docker.adopt(&UNCHANGED, crate::brand::SANDBOX_IMAGE));
        assert_eq!(*docker.calls.borrow(), [format!("exists {}", crate::brand::SANDBOX_IMAGE)]);
    }
}
