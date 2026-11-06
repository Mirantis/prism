//! Raw Body Capture
//!
//! HMAC verification of inbound webhooks (`lib/webhook_signature.rs`) has to hash
//! the exact bytes the sender signed — re-serializing the parsed JSON would
//! change whitespace and key order and never match. The JSON body parser
//! discards the buffer once it has parsed it, so the parser keeps a copy as a
//! request extension.

use bytes::Bytes;
use http::Extensions;

/// The raw body of a request, kept by [`capture_raw_body`] as a request extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawBodyRequest {
    pub raw_body: Bytes,
}

/// The JSON parser's hook: keep the raw buffer on the request.
pub fn capture_raw_body(extensions: &mut Extensions, buf: Bytes) {
    extensions.insert(RawBodyRequest { raw_body: buf });
}

/// The captured raw body, or `None` when nothing was captured (non-JSON
/// content type or empty body). Callers that need it for verification must
/// treat `None` as "cannot verify".
pub fn get_raw_body(extensions: &Extensions) -> Option<Bytes> {
    extensions
        .get::<RawBodyRequest>()
        .map(|captured| captured.raw_body.clone())
}
