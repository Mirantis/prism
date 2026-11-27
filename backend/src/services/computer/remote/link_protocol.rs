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
use serde_json::{Map, Value};

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

    /// `parse` of a value that may be missing (`undefined`), which every link schema, an
    /// object, refuses.
    fn parse_input(value: Option<&Value>) -> Result<Self, String> {
        match value {
            Some(value) => Self::parse(value),
            None => Err(expected("object", None)),
        }
    }
}

// ---------------------------------------------------------------------------
// The checks, with zod's messages

/// `Number.MAX_SAFE_INTEGER`, the bound of zod's `int()`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The type name zod's messages give a value; `None` is `undefined`.
fn type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn expected(kind: &str, value: Option<&Value>) -> String {
    format!(
        "Invalid input: expected {kind}, received {}",
        type_name(value)
    )
}

fn object(value: Option<&Value>) -> Result<&Map<String, Value>, String> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        other => Err(expected("object", other)),
    }
}

/// `z.string()` with `min` and `max` lengths, which zod counts in code points.
fn string(value: Option<&Value>, min: Option<usize>, max: Option<usize>) -> Result<String, String> {
    let Some(Value::String(text)) = value else {
        return Err(expected("string", value));
    };
    let length = text.chars().count();
    if let Some(min) = min
        && length < min
    {
        return Err(format!(
            "Too small: expected string to have >={min} characters"
        ));
    }
    if let Some(max) = max
        && length > max
    {
        return Err(format!(
            "Too big: expected string to have <={max} characters"
        ));
    }
    Ok(text.clone())
}

fn number(value: Option<&Value>) -> Result<f64, String> {
    match value {
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        other => Err(expected("number", other)),
    }
}

/// `z.number().int()`: a safe integer.
fn int(value: Option<&Value>) -> Result<i64, String> {
    let n = number(value)?;
    if n.fract() != 0.0 || !n.is_finite() {
        return Err("Invalid input: expected int, received number".to_string());
    }
    if n > MAX_SAFE_INTEGER {
        return Err("Too big: expected int to be <=9007199254740991".to_string());
    }
    if n < -MAX_SAFE_INTEGER {
        return Err("Too small: expected int to be >=-9007199254740991".to_string());
    }
    Ok(n as i64)
}

/// `z.number().int().min(min).max(max)`.
fn int_between(value: Option<&Value>, min: i64, max: i64) -> Result<i64, String> {
    let n = int(value)?;
    if n < min {
        return Err(format!("Too small: expected number to be >={min}"));
    }
    if n > max {
        return Err(format!("Too big: expected number to be <={max}"));
    }
    Ok(n)
}

/// `z.number().int().positive()`.
fn positive_int(value: Option<&Value>) -> Result<i64, String> {
    let n = int(value)?;
    if n <= 0 {
        return Err("Too small: expected number to be >0".to_string());
    }
    Ok(n)
}

fn boolean(value: Option<&Value>) -> Result<bool, String> {
    match value {
        Some(Value::Bool(b)) => Ok(*b),
        other => Err(expected("boolean", other)),
    }
}

/// `z.enum(options)`.
fn one_of(value: Option<&Value>, options: &[&'static str]) -> Result<&'static str, String> {
    let text = value.and_then(Value::as_str);
    options
        .iter()
        .find(|option| Some(**option) == text)
        .copied()
        .ok_or_else(|| {
            let listed: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
            format!("Invalid option: expected one of {}", listed.join("|"))
        })
}

/// `z.array(item).min(min).max(max)`: the items' issues come before the length's.
fn array_of<T>(
    value: Option<&Value>,
    min: Option<usize>,
    max: usize,
    item: impl Fn(Option<&Value>) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    let Some(Value::Array(items)) = value else {
        return Err(expected("array", value));
    };
    let parsed = items
        .iter()
        .map(|value| item(Some(value)))
        .collect::<Result<Vec<T>, String>>()?;
    if let Some(min) = min
        && items.len() < min
    {
        return Err(format!("Too small: expected array to have >={min} items"));
    }
    if items.len() > max {
        return Err(format!("Too big: expected array to have <={max} items"));
    }
    Ok(parsed)
}

/// A field with a zod `.default()`: the default when the key is absent.
fn or_default<T>(
    value: Option<&Value>,
    default: T,
    parse: impl Fn(Option<&Value>) -> Result<T, String>,
) -> Result<T, String> {
    match value {
        None => Ok(default),
        some => parse(some),
    }
}

// ---------------------------------------------------------------------------
// The schemas

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

fn display(value: Option<&Value>) -> Result<RemoteDisplay, String> {
    let fields = object(value)?;
    Ok(RemoteDisplay {
        id: string(fields.get("id"), Some(1), Some(100))?,
        width: int_between(fields.get("width"), 1, 16_384)?,
        height: int_between(fields.get("height"), 1, 16_384)?,
        scale: or_default(fields.get("scale"), 1.0, |value| {
            let n = number(value)?;
            if n <= 0.0 {
                return Err("Too small: expected number to be >0".to_string());
            }
            if n > 8.0 {
                return Err("Too big: expected number to be <=8".to_string());
            }
            Ok(n)
        })?,
        primary: or_default(fields.get("primary"), false, boolean)?,
    })
}

fn displays(value: Option<&Value>) -> Result<Vec<RemoteDisplay>, String> {
    array_of(value, Some(1), 16, display)
}

/// A capability the client names that this runtime does not know is left out, not refused.
fn capabilities(value: Option<&Value>) -> Result<Vec<Capability>, String> {
    let names = array_of(value, None, 50, |name| string(name, None, Some(50)))?;
    Ok(names
        .iter()
        .filter_map(|name| Capability::parse(name))
        .collect())
}

/// A capability the client says does not work, and why. Zod: `capability` at most 50
/// characters, `message` at most 500.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityProblem {
    pub capability: String,
    pub message: String,
}

fn problems(value: Option<&Value>) -> Result<Vec<CapabilityProblem>, String> {
    or_default(value, Vec::new(), |value| {
        array_of(value, None, 50, |problem| {
            let fields = object(problem)?;
            Ok(CapabilityProblem {
                capability: string(fields.get("capability"), None, Some(50))?,
                message: string(fields.get("message"), None, Some(500))?,
            })
        })
    })
}

/// The client program. Zod: `name` 1–100 characters; `version` matches `^[\w.+-]{1,50}$`,
/// since the version reaches telemetry, so it is a version and no other text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkClient {
    pub name: String,
    pub version: String,
}

fn client(value: Option<&Value>) -> Result<LinkClient, String> {
    let fields = object(value)?;
    let name = string(fields.get("name"), Some(1), Some(100))?;
    let version = string(fields.get("version"), None, None)?;
    let valid = (1..=50).contains(&version.len())
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'));
    if !valid {
        return Err("Invalid string: must match pattern /^[\\w.+-]{1,50}$/".to_string());
    }
    Ok(LinkClient { name, version })
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
        let fields = object(Some(value))?;
        let protocol_version = int(fields.get("protocolVersion"))?;
        let client = client(fields.get("client"))?;
        let platform = one_of(fields.get("platform"), &["macos", "windows", "linux"])?;
        Ok(InitializeParams {
            protocol_version,
            client,
            platform: RemotePlatform::parse(platform).unwrap_or(RemotePlatform::Linux),
            displays: displays(fields.get("displays"))?,
            capabilities: capabilities(fields.get("capabilities"))?,
            problems: problems(fields.get("problems"))?,
        })
    }
}

/// `displays.changed`. Zod: `displays` 1–16.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisplaysChangedParams {
    pub displays: Vec<RemoteDisplay>,
}

impl LinkSchema for DisplaysChangedParams {
    fn parse(value: &Value) -> Result<Self, String> {
        let fields = object(Some(value))?;
        Ok(DisplaysChangedParams {
            displays: displays(fields.get("displays"))?,
        })
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
        let fields = object(Some(value))?;
        Ok(CapabilitiesChangedParams {
            capabilities: capabilities(fields.get("capabilities"))?,
            problems: problems(fields.get("problems"))?,
        })
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
        let fields = object(Some(value))?;
        let media_type = match one_of(fields.get("mediaType"), &["image/jpeg", "image/png"])? {
            "image/png" => CaptureMediaType::Png,
            _ => CaptureMediaType::Jpeg,
        };
        Ok(CaptureResult {
            media_type,
            width: positive_int(fields.get("width"))?,
            height: positive_int(fields.get("height"))?,
            data: string(fields.get("data"), Some(1), None)?,
        })
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
        let fields = object(Some(value))?;
        let windows = array_of(fields.get("windows"), None, 500, |window| {
            let fields = object(window)?;
            Ok(RemoteWindow {
                id: string(fields.get("id"), Some(1), Some(200))?,
                title: string(fields.get("title"), None, Some(1000))?,
                app: or_default(fields.get("app"), String::new(), |v| {
                    string(v, None, Some(200))
                })?,
                x: number(fields.get("x"))?,
                y: number(fields.get("y"))?,
                width: number(fields.get("width"))?,
                height: number(fields.get("height"))?,
                focused: or_default(fields.get("focused"), false, boolean)?,
                minimized: or_default(fields.get("minimized"), false, boolean)?,
            })
        })?;
        Ok(WindowsResult { windows })
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
        let fields = object(Some(value))?;
        let elements = array_of(fields.get("elements"), None, 5000, |element| {
            let fields = object(element)?;
            Ok(RemoteElement {
                app: or_default(fields.get("app"), String::new(), |v| {
                    string(v, None, Some(200))
                })?,
                role: string(fields.get("role"), None, Some(100))?,
                name: string(fields.get("name"), None, Some(1000))?,
                x: number(fields.get("x"))?,
                y: number(fields.get("y"))?,
                width: number(fields.get("width"))?,
                height: number(fields.get("height"))?,
            })
        })?;
        Ok(ElementsResult { elements })
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
        let fields = object(Some(value))?;
        let encoding = match one_of(fields.get("encoding"), &["h264", "jpeg"])? {
            "h264" => StreamEncoding::H264,
            _ => StreamEncoding::Jpeg,
        };
        let codec = match fields.get("codec") {
            None => None,
            some => Some(string(some, None, Some(100))?),
        };
        Ok(StreamStartResult {
            encoding,
            codec,
            width: positive_int(fields.get("width"))?,
            height: positive_int(fields.get("height"))?,
        })
    }
}

/// The answer to a request that returns nothing: any object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EmptyResult {}

impl LinkSchema for EmptyResult {
    fn parse(value: &Value) -> Result<Self, String> {
        object(Some(value))?;
        Ok(EmptyResult {})
    }
}

/// A JSON-RPC id: an integer, or text of at most 100 characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(i64),
    Text(String),
}

/// The id a message names, when it is one the schema takes.
fn rpc_id(value: Option<&Value>) -> Option<RpcId> {
    match value? {
        Value::String(_) => string(value, None, Some(100)).ok().map(RpcId::Text),
        Value::Number(_) => int(value).ok().map(RpcId::Number),
        _ => None,
    }
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
/// the order of `RpcMessage`, so a `method` with an id the schema does not take reads as a
/// notification, and an error is tried before a result.
pub fn parse_rpc_message(value: &Value) -> Option<RpcMessage> {
    let fields = value.as_object()?;
    if fields.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let method = string(fields.get("method"), None, Some(100)).ok();
    let id = rpc_id(fields.get("id"));
    if let Some(method) = method {
        let params = fields.get("params").cloned();
        return Some(match id {
            Some(id) => RpcMessage::Request { id, method, params },
            None => RpcMessage::Notification { method, params },
        });
    }
    if let Some(error) = rpc_error(fields) {
        return Some(error);
    }
    match (id, fields.get("result")) {
        (Some(id), Some(result)) => Some(RpcMessage::Response {
            id,
            result: result.clone(),
        }),
        _ => None,
    }
}

/// The error variant: an `id` that is null or one the schema takes, and an error object.
fn rpc_error(fields: &Map<String, Value>) -> Option<RpcMessage> {
    let id = match fields.get("id")? {
        Value::Null => None,
        _ => Some(rpc_id(fields.get("id"))?),
    };
    let error = object(fields.get("error")).ok()?;
    let code = int(error.get("code")).ok()?;
    let message = string(error.get("message"), None, Some(2000)).ok()?;
    Some(RpcMessage::Error {
        id,
        error: RpcErrorObject {
            code,
            message,
            data: error.get("data").cloned(),
        },
    })
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// A client's `hello` for a Mac with one display.
    pub(crate) fn hello() -> Value {
        json!({
            "protocolVersion": 1,
            "client": { "name": "test-client", "version": "1.2.3" },
            "platform": "macos",
            "displays": [{ "id": "main", "width": 2560, "height": 1440, "scale": 2, "primary": true }],
            "capabilities": ["screen", "input", "windows", "stream", "teleport"],
        })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut params = hello();
        params[key] = value;
        params
    }

    fn issue(value: Value) -> String {
        InitializeParams::parse(&value).expect_err("the params are refused")
    }

    #[test]
    fn reads_initialize_leaving_out_capabilities_it_does_not_know() {
        let params = InitializeParams::parse(&hello()).unwrap();
        assert_eq!(params.protocol_version, 1);
        assert_eq!(params.platform, RemotePlatform::Macos);
        assert_eq!(
            params.capabilities,
            [
                Capability::Screen,
                Capability::Input,
                Capability::Windows,
                Capability::Stream
            ]
        );
        assert!(params.problems.is_empty());
        assert_eq!(params.displays[0].scale, 2.0);
    }

    #[test]
    fn fills_the_display_defaults() {
        let params = InitializeParams::parse(&with(
            "displays",
            json!([{ "id": "a", "width": 1, "height": 1, "extra": 2 }]),
        ))
        .unwrap();
        assert_eq!(
            params.displays,
            [RemoteDisplay {
                id: "a".into(),
                width: 1,
                height: 1,
                scale: 1.0,
                primary: false
            }]
        );
    }

    #[test]
    fn answers_the_first_issue_as_zod_words_it() {
        assert_eq!(
            InitializeParams::parse_input(None).unwrap_err(),
            "Invalid input: expected object, received undefined"
        );
        assert_eq!(
            issue(json!([])),
            "Invalid input: expected object, received array"
        );
        assert_eq!(
            issue(json!({})),
            "Invalid input: expected number, received undefined"
        );
        assert_eq!(
            issue(with("protocolVersion", json!("1"))),
            "Invalid input: expected number, received string"
        );
        assert_eq!(
            issue(with("protocolVersion", json!(1.5))),
            "Invalid input: expected int, received number"
        );
        assert_eq!(
            issue(with("protocolVersion", json!(1e20))),
            "Too big: expected int to be <=9007199254740991"
        );
        assert_eq!(
            issue(with("client", json!({ "name": "", "version": "1" }))),
            "Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            issue(with("client", json!({ "name": "a", "version": "1 2" }))),
            "Invalid string: must match pattern /^[\\w.+-]{1,50}$/"
        );
        assert_eq!(
            issue(with("client", json!({ "name": "a", "version": "é" }))),
            "Invalid string: must match pattern /^[\\w.+-]{1,50}$/"
        );
        assert_eq!(
            issue(with("platform", json!("beos"))),
            "Invalid option: expected one of \"macos\"|\"windows\"|\"linux\""
        );
        assert_eq!(
            issue(with("displays", json!([]))),
            "Too small: expected array to have >=1 items"
        );
        assert_eq!(
            issue(with(
                "displays",
                json!([{ "id": "a", "width": 1, "height": 1, "scale": 0 }])
            )),
            "Too small: expected number to be >0"
        );
        assert_eq!(
            issue(with(
                "displays",
                json!([{ "id": "a", "width": 16385, "height": 1 }])
            )),
            "Too big: expected number to be <=16384"
        );
        assert_eq!(
            issue(with(
                "displays",
                json!([{ "id": "a", "width": 1, "height": 1, "scale": null }])
            )),
            "Invalid input: expected number, received null"
        );
        assert_eq!(
            issue(with("capabilities", json!(["x".repeat(51)]))),
            "Too big: expected string to have <=50 characters"
        );
        assert_eq!(
            issue(with("problems", json!([{ "capability": "x" }]))),
            "Invalid input: expected string, received undefined"
        );
        let many: Vec<Value> = (0..17)
            .map(|_| json!({ "id": "", "width": 1, "height": 1 }))
            .collect();
        assert_eq!(
            issue(with("displays", Value::Array(many))),
            "Too small: expected string to have >=1 characters"
        );
    }

    #[test]
    fn counts_a_name_in_code_points() {
        let name = "😀".repeat(100);
        let params =
            InitializeParams::parse(&with("client", json!({ "name": name, "version": "1" })));
        assert!(params.is_ok());
        let name = "😀".repeat(101);
        assert_eq!(
            issue(with("client", json!({ "name": name, "version": "1" }))),
            "Too big: expected string to have <=100 characters"
        );
    }

    #[test]
    fn tells_the_kinds_of_message_apart() {
        let read = |value: Value| parse_rpc_message(&value);
        assert_eq!(
            read(json!({ "jsonrpc": "2.0", "id": 1, "method": "a" })),
            Some(RpcMessage::Request {
                id: RpcId::Number(1),
                method: "a".into(),
                params: None
            })
        );
        // An id the schema does not take leaves a notification.
        for id in [json!(1.5), json!(null), json!("x".repeat(101))] {
            assert_eq!(
                read(json!({ "jsonrpc": "2.0", "id": id, "method": "a" })),
                Some(RpcMessage::Notification {
                    method: "a".into(),
                    params: None
                })
            );
        }
        assert_eq!(
            read(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": 1, "message": "m" } })),
            Some(RpcMessage::Error {
                id: None,
                error: RpcErrorObject {
                    code: 1,
                    message: "m".into(),
                    data: None
                }
            })
        );
        // An error is read before a result.
        assert!(matches!(
            read(
                json!({ "jsonrpc": "2.0", "id": 1, "result": 2, "error": { "code": 1, "message": "m" } })
            ),
            Some(RpcMessage::Error { .. })
        ));
        assert_eq!(
            read(json!({ "jsonrpc": "2.0", "id": 1, "result": { "a": 1 } })),
            Some(RpcMessage::Response {
                id: RpcId::Number(1),
                result: json!({ "a": 1 })
            })
        );
        for refused in [
            json!({ "jsonrpc": "2.0", "error": { "code": 1, "message": "m" } }),
            json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": 1.5, "message": "m" } }),
            json!({ "jsonrpc": "2.0", "id": 1 }),
            json!({ "jsonrpc": "2.0", "id": null, "result": 1 }),
            json!({ "jsonrpc": "1.0", "id": 1, "method": "a" }),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "a".repeat(101) }),
            json!([1]),
        ] {
            assert_eq!(read(refused.clone()), None, "{refused}");
        }
    }

    #[test]
    fn fills_the_defaults_of_a_window_and_an_element() {
        let windows = WindowsResult::parse(
            &json!({ "windows": [{ "id": "w", "title": "t", "x": 1, "y": 2, "width": 3, "height": 4 }] }),
        )
        .unwrap();
        assert_eq!(windows.windows[0].app, "");
        assert!(!windows.windows[0].focused && !windows.windows[0].minimized);
        let elements = ElementsResult::parse(
            &json!({ "elements": [{ "role": "r", "name": "n", "x": 1.5, "y": 2, "width": 3, "height": 4 }] }),
        )
        .unwrap();
        assert_eq!(elements.elements[0].app, "");
        assert_eq!(elements.elements[0].x, 1.5);
    }

    #[test]
    fn takes_any_object_as_an_empty_result() {
        assert!(EmptyResult::parse(&json!({ "a": 1 })).is_ok());
        assert!(EmptyResult::parse(&json!(null)).is_err());
        assert!(EmptyResult::parse(&json!([])).is_err());
        assert!(
            CaptureResult::parse(
                &json!({ "mediaType": "image/jpeg", "width": 1, "height": 1, "data": "" })
            )
            .is_err()
        );
        let started =
            StreamStartResult::parse(&json!({ "encoding": "h264", "width": 3, "height": 4 }))
                .unwrap();
        assert_eq!(started.encoding, StreamEncoding::H264);
        assert_eq!(started.codec, None);
    }
}
