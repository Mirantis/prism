//! The computer link, version 1: what a remote computer's client and the runtime say to
//! each other on `/api/computer-link`. `docs/computer-link-protocol.md` is the contract
//! for client authors; these schemas are where the runtime reads it.
//!
//! Text frames are JSON-RPC 2.0, one message each, with requests in both directions.
//! Binary frames hold the screen stream.
//!
//! Each schema is a serde type plus `LinkSchema::parse`, which applies the checks, the
//! defaults and the transforms of the zod schema it stands for and answers the first
//! issue's message when the value fails them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::computer::desktop_windows::Titled;
use crate::services::computer::picture_stream::StreamEncoding;

pub const COMPUTER_LINK_PATH: &str = "/api/computer-link";
pub const LINK_PROTOCOL_VERSION: i64 = 1;

/// The largest frame either side sends: a full-size PNG of a large screen, as base64.
pub const MAX_LINK_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// The first byte of a binary frame; the second holds flags.
pub const LINK_JPEG_FRAME: u8 = 0x01;
pub const LINK_VIDEO_FRAME: u8 = 0x03;
/// Flag bit 0 of a video frame: the picture stands on its own.
pub const LINK_KEYFRAME_FLAG: u8 = 0x01;

/// The close codes of a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkCloseCodes {
    pub shutting_down: u16,
    pub protocol_error: u16,
    pub removed: u16,
    pub replaced: u16,
    pub unsupported_version: u16,
}

/// Close codes, each with what the client does next (see the protocol doc).
pub const LINK_CLOSE: LinkCloseCodes = LinkCloseCodes {
    shutting_down: 1001,
    protocol_error: 4400,
    removed: 4403,
    replaced: 4409,
    unsupported_version: 4426,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemotePlatform {
    Macos,
    Windows,
    Linux,
}

impl RemotePlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            RemotePlatform::Macos => "macos",
            RemotePlatform::Windows => "windows",
            RemotePlatform::Linux => "linux",
        }
    }

    /// The platform `text` names, or `None` for any other text.
    pub fn parse(text: &str) -> Option<RemotePlatform> {
        PLATFORMS
            .into_iter()
            .find(|platform| platform.as_str() == text)
    }
}

pub const PLATFORMS: [RemotePlatform; 3] = [
    RemotePlatform::Macos,
    RemotePlatform::Windows,
    RemotePlatform::Linux,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Screen,
    Input,
    Windows,
    Elements,
    Stream,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Screen => "screen",
            Capability::Input => "input",
            Capability::Windows => "windows",
            Capability::Elements => "elements",
            Capability::Stream => "stream",
        }
    }

    /// The capability `text` names, or `None` for one this runtime does not know.
    pub fn parse(text: &str) -> Option<Capability> {
        CAPABILITIES
            .into_iter()
            .find(|capability| capability.as_str() == text)
    }
}

pub const CAPABILITIES: [Capability; 5] = [
    Capability::Screen,
    Capability::Input,
    Capability::Windows,
    Capability::Elements,
    Capability::Stream,
];

/// Why the client refused a request, in `error.data.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkErrorReason {
    PermissionDenied,
    Unsupported,
    Held,
    Busy,
    InvalidParams,
    Internal,
}

impl LinkErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkErrorReason::PermissionDenied => "permission_denied",
            LinkErrorReason::Unsupported => "unsupported",
            LinkErrorReason::Held => "held",
            LinkErrorReason::Busy => "busy",
            LinkErrorReason::InvalidParams => "invalid_params",
            LinkErrorReason::Internal => "internal",
        }
    }
}

/// A link message read with the checks, defaults and transforms of its zod schema.
pub trait LinkSchema: Sized + Send + 'static {
    /// The value read, or the message of the first issue found.
    fn parse(value: &Value) -> Result<Self, String>;
}

/// One display of a remote computer. Zod: `id` 1–100 characters, `width` and `height`
/// integers 1–16384, `scale` positive and at most 8 (default 1), `primary` default false.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteDisplay {
    pub id: String,
    pub width: i64,
    pub height: i64,
    pub scale: f64,
    pub primary: bool,
}

/// A capability the client says does not work, and why. Zod: `capability` at most 50
/// characters, `message` at most 500.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityProblem {
    pub capability: String,
    pub message: String,
}

/// The client program. Zod: `name` 1–100 characters; `version` matches `^[\w.+-]{1,50}$`,
/// since the version reaches telemetry, so it is a version and no other text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkClient {
    pub name: String,
    pub version: String,
}

/// The `initialize` request's params. Zod: `protocolVersion` an integer, `displays` 1–16,
/// `capabilities` at most 50 names of at most 50 characters with the names this runtime
/// does not know left out rather than refused, `problems` at most 50 (default empty).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: i64,
    pub client: LinkClient,
    pub platform: RemotePlatform,
    pub displays: Vec<RemoteDisplay>,
    pub capabilities: Vec<Capability>,
    pub problems: Vec<CapabilityProblem>,
}

impl LinkSchema for InitializeParams {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

/// `displays.changed`. Zod: `displays` 1–16.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisplaysChangedParams {
    pub displays: Vec<RemoteDisplay>,
}

impl LinkSchema for DisplaysChangedParams {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

/// `capabilities.changed`, read as `InitializeParams` reads its two fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilitiesChangedParams {
    pub capabilities: Vec<Capability>,
    pub problems: Vec<CapabilityProblem>,
}

impl LinkSchema for CapabilitiesChangedParams {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaptureMediaType {
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/png")]
    Png,
}

impl CaptureMediaType {
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureMediaType::Jpeg => "image/jpeg",
            CaptureMediaType::Png => "image/png",
        }
    }
}

/// The answer to `screen.capture`. Zod: `width` and `height` positive integers, `data`
/// non-empty base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub media_type: CaptureMediaType,
    pub width: i64,
    pub height: i64,
    pub data: String,
}

impl LinkSchema for CaptureResult {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

/// One window of a remote computer. Zod: `id` 1–200 characters, `title` at most 1000,
/// `app` at most 200 (default empty), `focused` and `minimized` default false.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteWindow {
    pub id: String,
    pub title: String,
    pub app: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub focused: bool,
    pub minimized: bool,
}

impl Titled for RemoteWindow {
    fn title(&self) -> &str {
        &self.title
    }
}

/// The answer to `windows.list`. Zod: at most 500 windows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowsResult {
    pub windows: Vec<RemoteWindow>,
}

impl LinkSchema for WindowsResult {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

/// One control of a remote computer. `role` is an AT-SPI role name; Prism acts on those in
/// `ACTIONABLE_ROLES` and ignores the rest. Zod: `app` at most 200 characters (default
/// empty), `role` at most 100, `name` at most 1000.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteElement {
    pub app: String,
    pub role: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The answer to `elements.list`. Zod: at most 5000 elements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElementsResult {
    pub elements: Vec<RemoteElement>,
}

impl LinkSchema for ElementsResult {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

/// The answer to `stream.start`. Zod: `codec` at most 100 characters, `width` and `height`
/// positive integers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamStartResult {
    pub encoding: StreamEncoding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    pub width: i64,
    pub height: i64,
}

impl LinkSchema for StreamStartResult {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

/// The answer to a request that returns nothing: any object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EmptyResult {}

impl LinkSchema for EmptyResult {
    fn parse(value: &Value) -> Result<Self, String> {
        todo!()
    }
}

/// A JSON-RPC id: an integer, or text of at most 100 characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(i64),
    Text(String),
}

/// A JSON-RPC error object. Zod: `code` an integer, `message` at most 2000 characters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// One JSON-RPC 2.0 message, read loosely enough to tell its kind apart. `method` is at
/// most 100 characters.
#[derive(Debug, Clone, PartialEq)]
pub enum RpcMessage {
    Request {
        id: RpcId,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    Error {
        id: Option<RpcId>,
        error: RpcErrorObject,
    },
    Response {
        id: RpcId,
        result: Value,
    },
}

/// Read one JSON-RPC 2.0 message, or `None` when it is not one. The variants are tried in
/// the order of `RpcMessage`: an error is tried before a result, since a missing `result`
/// reads as `undefined`.
pub fn parse_rpc_message(value: &Value) -> Option<RpcMessage> {
    todo!()
}

/// The JSON-RPC 2.0 error codes the runtime answers with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RpcErrorCodes {
    pub invalid_request: i64,
    pub method_not_found: i64,
    pub invalid_params: i64,
}

pub const RPC_ERROR: RpcErrorCodes = RpcErrorCodes {
    invalid_request: -32600,
    method_not_found: -32601,
    invalid_params: -32602,
};
