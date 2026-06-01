//! In-flight request de-duplication — port of `dedupe()` in `proxy/server.js`.
//!
//! Concurrent callers keyed the same share a single in-progress future instead
//! of each launching its own upstream scrape. The shared output must be `Clone`
//! (we use `Result<_, String>` since `anyhow::Error` is not `Clone`).

use std::future::Future;

use dashmap::{mapref::entry::Entry, DashMap};
use futures::future::{BoxFuture, FutureExt, Shared};

pub struct SingleFlight<T: Clone + Send + 'static> {
    inflight: DashMap<String, Shared<BoxFuture<'static, T>>>,
}

impl<T: Clone + Send + 'static> Default for SingleFlight<T> {
    fn default() -> Self {
        Self { inflight: DashMap::new() }
    }
}

impl<T: Clone + Send + 'static> SingleFlight<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `f` for `key`, or join the existing in-flight call. The key is
    /// cleared once the shared future resolves (as in the JS `.finally`).
    pub async fn run<F, Fut>(&self, key: &str, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T> + Send + 'static,
    {
        let shared = match self.inflight.entry(key.to_string()) {
            Entry::Occupied(e) => e.get().clone(),
            Entry::Vacant(e) => {
                let fut = f().boxed().shared();
                e.insert(fut.clone());
                fut
            }
        };
        let result = shared.await;
        self.inflight.remove(key);
        result
    }
}
