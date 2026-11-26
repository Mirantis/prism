//! What the agent spent on models, read from the estimated cost on each `llm_calls`
//! row: in a time range, per calendar period, per thread, per request and per
//! scheduled task, webhook or goal.
//!
//! A cost is an estimate from catalog prices. A call whose model has no price is
//! counted in `unpricedCalls` and adds nothing to `costUsd`, so a total with
//! unpriced calls is a lower bound.

use std::collections::HashMap;
use std::sync::LazyLock;

use anyhow::anyhow;
use chrono::{DateTime, Datelike, Utc};
use diesel::dsl::{count, count_star};
use diesel::prelude::*;
use diesel::sql_types::{BigInt, Nullable, Text};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::config::CONFIG;
use crate::db::models::ThreadSource;
use crate::db::schema::llm_calls::dsl as l;
use crate::db::schema::{
    conversation_messages, conversation_threads, cron_tasks, goals, webhook_subscriptions,
};
use crate::db::sql_types::{DbDateTime, PrismaDateTime};
use crate::lib::spend_context::SpendSourceKind;
use crate::lib::timezone::resolve_timezone;
use crate::lib::zoned_time::{date_utc, wall_clock, zoned_instant};
use crate::services::llm_call_service::{SpendKind, spend_kind_of};
use crate::services::web_thread::is_web_thread;
use crate::support::{from_ms, iso, js};

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendTotals {
    #[serde(serialize_with = "js::number_serde::serialize")]
    pub cost_usd: f64,
    pub calls: i64,
    /// Calls with no price, which `cost_usd` leaves out.
    pub unpriced_calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

/// Where spend went, in the words a person uses for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpendCategory {
    Conversations,
    CodingAgent,
    Voice,
    Heartbeat,
    ScheduledTasks,
    Webhooks,
    Goals,
    Background,
}

/// The categories whose spend is listed per scheduled task, webhook or goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourcedCategory {
    ScheduledTasks,
    Webhooks,
    Goals,
}

pub const SOURCED_CATEGORIES: [SourcedCategory; 3] = [
    SourcedCategory::ScheduledTasks,
    SourcedCategory::Webhooks,
    SourcedCategory::Goals,
];

impl SourcedCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ScheduledTasks => "scheduled-tasks",
            Self::Webhooks => "webhooks",
            Self::Goals => "goals",
        }
    }

    pub fn parse(value: &str) -> Option<SourcedCategory> {
        SOURCED_CATEGORIES
            .into_iter()
            .find(|category| category.as_str() == value)
    }

    fn category(&self) -> SpendCategory {
        match self {
            Self::ScheduledTasks => SpendCategory::ScheduledTasks,
            Self::Webhooks => SpendCategory::Webhooks,
            Self::Goals => SpendCategory::Goals,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindSpend {
    pub kind: SpendKind,
    #[serde(flatten)]
    pub totals: SpendTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySpend {
    pub category: SpendCategory,
    #[serde(flatten)]
    pub totals: SpendTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpend {
    pub model: String,
    #[serde(flatten)]
    pub totals: SpendTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurposeSpend {
    pub purpose: String,
    #[serde(flatten)]
    pub totals: SpendTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendBreakdown {
    #[serde(flatten)]
    pub totals: SpendTotals,
    pub by_kind: Vec<KindSpend>,
    pub by_category: Vec<CategorySpend>,
    pub by_model: Vec<ModelSpend>,
    pub by_purpose: Vec<PurposeSpend>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpendRange {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpendPeriod {
    Day,
    Week,
    Month,
}

/// `cost_usd` split by kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct CostByKind {
    #[serde(serialize_with = "js::number_serde::serialize")]
    pub main: f64,
    #[serde(
        rename = "coding-agent",
        serialize_with = "js::number_serde::serialize"
    )]
    pub coding_agent: f64,
    #[serde(serialize_with = "js::number_serde::serialize")]
    pub voice: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSpend {
    /// The period's first local date, `YYYY-MM-DD`.
    pub start: String,
    pub from: String,
    pub to: String,
    #[serde(flatten)]
    pub totals: SpendTotals,
    pub cost_usd_by_kind: CostByKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSpend {
    pub thread_id: String,
    pub title: Option<String>,
    /// The requests spent in the thread: the messages answered and the runs made in it.
    pub requests: i64,
    pub first_call_at: String,
    pub last_call_at: String,
    #[serde(flatten)]
    pub totals: SpendTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSpendPage {
    pub threads: Vec<ThreadSpend>,
    pub next_offset: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpend {
    pub request_id: String,
    /// What the request was: `message`, `agent-message`, `task-result`, the source
    /// kind of a run, or `other`.
    pub kind: String,
    /// The start of the message the request answers, for a message alone.
    pub preview: Option<String>,
    pub first_call_at: String,
    #[serde(flatten)]
    pub totals: SpendTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSpendDetail {
    pub thread_id: String,
    pub title: Option<String>,
    /// True for a web thread, which web chat opens by its id.
    pub opens_in_chat: bool,
    #[serde(flatten)]
    pub breakdown: SpendBreakdown,
    pub requests: Vec<RequestSpend>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpendDetail {
    pub request_id: String,
    pub thread_id: Option<String>,
    #[serde(flatten)]
    pub breakdown: SpendBreakdown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpend {
    /// `None` for the spend recorded before runs named their source.
    pub source_id: Option<String>,
    /// The task's, webhook's or goal's name; `None` when it was deleted or is unknown.
    pub name: Option<String>,
    #[serde(flatten)]
    pub totals: SpendTotals,
}

const PREVIEW_CHARS: usize = 120;

#[diesel::declare_sql_function]
extern "SQL" {
    /// SQLite's `SUM` over an integer column, which it answers as an integer.
    #[aggregate]
    #[sql_name = "SUM"]
    fn int_sum(x: BigInt) -> Nullable<BigInt>;

    /// SQLite's `SUM` over a nullable integer column.
    #[aggregate]
    #[sql_name = "SUM"]
    fn cost_sum(x: Nullable<BigInt>) -> Nullable<BigInt>;

    #[aggregate]
    #[sql_name = "MIN"]
    fn first_at(x: PrismaDateTime) -> Nullable<PrismaDateTime>;

    #[aggregate]
    #[sql_name = "MAX"]
    fn last_at(x: PrismaDateTime) -> Nullable<PrismaDateTime>;

    #[aggregate]
    #[sql_name = "MIN"]
    fn min_text(x: Nullable<Text>) -> Nullable<Text>;
}

/// The sums one grouped row has, which every read adds up the same way: the call
/// count, the priced call count, and the sums of the cost and the token columns.
type Sums = (
    i64,
    i64,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
);

/// The select list of [`Sums`].
macro_rules! sums {
    () => {
        (
            count_star(),
            count(l::cost_micro_usd),
            cost_sum(l::cost_micro_usd),
            int_sum(l::input_tokens),
            int_sum(l::output_tokens),
            int_sum(l::cache_read_tokens),
            int_sum(l::cache_write_tokens),
        )
    };
}

/// Running totals in micro-dollars, converted once at the end so rounding never accumulates.
#[derive(Debug, Clone, Copy, Default)]
struct Accumulator {
    cost_micro_usd: i64,
    calls: i64,
    priced_calls: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
}

impl Accumulator {
    fn add(&mut self, row: &Sums) {
        let (calls, priced, cost, input, output, read, write) = *row;
        self.cost_micro_usd += cost.unwrap_or(0);
        self.calls += calls;
        self.priced_calls += priced;
        self.input_tokens += input.unwrap_or(0);
        self.output_tokens += output.unwrap_or(0);
        self.cache_read_tokens += read.unwrap_or(0);
        self.cache_write_tokens += write.unwrap_or(0);
    }

    fn totals(&self) -> SpendTotals {
        SpendTotals {
            cost_usd: usd(self.cost_micro_usd),
            calls: self.calls,
            unpriced_calls: self.calls - self.priced_calls,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
        }
    }
}

fn usd(micro_usd: i64) -> f64 {
    micro_usd as f64 / 1_000_000.0
}

fn totals_of_row(row: &Sums) -> SpendTotals {
    let mut acc = Accumulator::default();
    acc.add(row);
    acc.totals()
}

fn add_to<K: std::hash::Hash + Eq>(groups: &mut IndexMap<K, Accumulator>, key: K, row: &Sums) {
    groups.entry(key).or_default().add(row);
}

/// One entry per key, most spent first.
fn ranked<K: Clone, T>(
    groups: &IndexMap<K, Accumulator>,
    entry: impl Fn(K, SpendTotals) -> T,
) -> Vec<T> {
    let mut sorted: Vec<(&K, &Accumulator)> = groups.iter().collect();
    sorted.sort_by(|(_, a), (_, b)| {
        b.cost_micro_usd
            .cmp(&a.cost_micro_usd)
            .then(b.calls.cmp(&a.calls))
    });
    sorted
        .into_iter()
        .map(|(key, acc)| entry(key.clone(), acc.totals()))
        .collect()
}

fn category_of_source(source: SpendSourceKind) -> SpendCategory {
    match source {
        SpendSourceKind::Chat => SpendCategory::Conversations,
        SpendSourceKind::Heartbeat => SpendCategory::Heartbeat,
        SpendSourceKind::Cron => SpendCategory::ScheduledTasks,
        SpendSourceKind::Webhook => SpendCategory::Webhooks,
        SpendSourceKind::Goal => SpendCategory::Goals,
        SpendSourceKind::VoiceChat | SpendSourceKind::Meeting | SpendSourceKind::Dictation => {
            SpendCategory::Voice
        }
    }
}

/// The invoke modes a call recorded before sources were stored names as its purpose.
fn source_of_purpose(purpose: &str) -> Option<SpendSourceKind> {
    match purpose {
        "chat" => Some(SpendSourceKind::Chat),
        "heartbeat" => Some(SpendSourceKind::Heartbeat),
        "cron" => Some(SpendSourceKind::Cron),
        "webhook" => Some(SpendSourceKind::Webhook),
        "goal" => Some(SpendSourceKind::Goal),
        _ => None,
    }
}

/// A call's category. The coding agent's and the voice models' own calls are their
/// kind; any other call is the category of what started its request, and a call
/// that no request started (a thread title, an idle compaction) is background work.
pub fn category_of(purpose: &str, source_kind: Option<&str>) -> SpendCategory {
    match spend_kind_of(purpose) {
        SpendKind::CodingAgent => return SpendCategory::CodingAgent,
        SpendKind::Voice => return SpendCategory::Voice,
        SpendKind::Main => {}
    }
    let source = match source_kind {
        Some(text) => SpendSourceKind::parse(text),
        None => source_of_purpose(purpose),
    };
    source.map_or(SpendCategory::Background, category_of_source)
}

/// The agent whose rows are read. Subagent work is recorded against the owner.
fn owner() -> String {
    CONFIG.agent_id().unwrap_or_default()
}

/// A local calendar date, as `Date.UTC` reads it: out-of-range days and months roll over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalDate {
    year: i32,
    month: i64,
    day: i64,
}

fn normalized(date: LocalDate) -> LocalDate {
    let at = from_ms(date_utc(date.year, date.month - 1, date.day, 0, 0, 0));
    LocalDate {
        year: at.year(),
        month: at.month() as i64,
        day: at.day() as i64,
    }
}

fn label(date: LocalDate) -> String {
    format!("{}-{:02}-{:02}", date.year, date.month, date.day)
}

/// The first day of the period that holds `date`. A week starts on Monday.
fn period_start(period: SpendPeriod, date: LocalDate) -> LocalDate {
    match period {
        SpendPeriod::Month => LocalDate { day: 1, ..date },
        SpendPeriod::Day => date,
        SpendPeriod::Week => {
            let weekday = from_ms(date_utc(date.year, date.month - 1, date.day, 0, 0, 0))
                .weekday()
                .num_days_from_sunday() as i64;
            normalized(LocalDate {
                day: date.day - (weekday + 6) % 7,
                ..date
            })
        }
    }
}

/// The period `steps` periods after the one that starts on `start`.
fn shifted(period: SpendPeriod, start: LocalDate, steps: i64) -> LocalDate {
    match period {
        SpendPeriod::Month => normalized(LocalDate {
            year: start.year,
            month: start.month + steps,
            day: 1,
        }),
        SpendPeriod::Week => normalized(LocalDate {
            day: start.day + steps * 7,
            ..start
        }),
        SpendPeriod::Day => normalized(LocalDate {
            day: start.day + steps,
            ..start
        }),
    }
}

fn start_instant(date: LocalDate, timezone: chrono_tz::Tz) -> i64 {
    zoned_instant(date.year, date.month as u32, date.day, 0, 0, timezone)
}

/// The first `PREVIEW_CHARS` UTF-16 units of `content`, with its whitespace runs
/// collapsed to one space.
fn preview_of(content: &str) -> String {
    let mut flat = String::with_capacity(content.len());
    let mut in_space = false;
    for ch in content.chars() {
        if js::is_js_whitespace(ch) {
            if !in_space {
                flat.push(' ');
            }
            in_space = true;
        } else {
            flat.push(ch);
            in_space = false;
        }
    }
    let flat = js::trim(&flat);
    if js::len16(flat) > PREVIEW_CHARS {
        format!("{}…", js::slice16(flat, 0, PREVIEW_CHARS - 1))
    } else {
        flat.to_string()
    }
}

/// What a request was, from the message it answers or, for a run, what started it.
fn request_kind(triggered_by: Option<&str>, source_kind: Option<&str>) -> String {
    match triggered_by {
        Some("TASK_NOTIFICATION") => "task-result".into(),
        Some("AGENT_MESSAGE") => "agent-message".into(),
        Some(_) => "message".into(),
        None => source_kind.unwrap_or("other").to_string(),
    }
}

/// The rows a breakdown reads.
enum Scope {
    Range(SpendRange),
    Thread(String),
    Request(String),
}

type BreakdownRow = (String, String, Option<String>, Sums);

pub struct SpendingService;

impl SpendingService {
    /// Totals for `range`, by kind, category, model and purpose.
    pub async fn summary(&self, range: SpendRange) -> anyhow::Result<SpendBreakdown> {
        breakdown(Scope::Range(range)).await
    }

    /// The last `count` periods in `timezone`, the current one included, oldest first.
    /// A period with no calls is listed with zeros.
    pub async fn periods(
        &self,
        period: SpendPeriod,
        count: i64,
        timezone: &str,
        now: i64,
    ) -> anyhow::Result<Vec<PeriodSpend>> {
        let zone = resolve_timezone(timezone)
            .ok_or_else(|| anyhow!("Invalid time zone specified: {timezone}"))?;
        let today = wall_clock(now, zone);
        let current = period_start(
            period,
            LocalDate {
                year: today.year,
                month: today.month as i64,
                day: today.day as i64,
            },
        );
        let starts: Vec<LocalDate> = (0..=count)
            .map(|i| shifted(period, current, i - count + 1))
            .collect();
        let bounds: Vec<i64> = starts.iter().map(|s| start_instant(*s, zone)).collect();

        let (owner, from, to) = (
            owner(),
            DbDateTime(from_ms(bounds[0])),
            DbDateTime(from_ms(bounds[count as usize])),
        );
        let rows: Vec<(DateTime<Utc>, String, Sums)> = crate::db::read(move |conn| {
            Ok(l::llm_calls
                .filter(l::agent_id.eq(&owner))
                .filter(l::bucket.ge(from))
                .filter(l::bucket.lt(to))
                .group_by((l::bucket, l::purpose))
                .select((l::bucket, l::purpose, sums!()))
                .load(conn)?)
        })
        .await?;

        // A period starts at a local midnight, which is a whole 15-minute bucket in every zone.
        let count = count as usize;
        let mut accumulators = vec![Accumulator::default(); count];
        let mut by_kind = vec![(0i64, 0i64, 0i64); count];
        for (bucket, purpose, sums) in &rows {
            let at = bucket.timestamp_millis();
            let Some(index) = (0..count).find(|&i| at >= bounds[i] && at < bounds[i + 1]) else {
                continue;
            };
            accumulators[index].add(sums);
            let cost = sums.2.unwrap_or(0);
            match spend_kind_of(purpose) {
                SpendKind::Main => by_kind[index].0 += cost,
                SpendKind::CodingAgent => by_kind[index].1 += cost,
                SpendKind::Voice => by_kind[index].2 += cost,
            }
        }

        Ok(accumulators
            .iter()
            .enumerate()
            .map(|(i, acc)| PeriodSpend {
                start: label(starts[i]),
                from: iso(&from_ms(bounds[i])),
                to: iso(&from_ms(bounds[i + 1])),
                totals: acc.totals(),
                cost_usd_by_kind: CostByKind {
                    main: usd(by_kind[i].0),
                    coding_agent: usd(by_kind[i].1),
                    voice: usd(by_kind[i].2),
                },
            })
            .collect())
    }

    /// Threads with calls in `range`, most spent first, `limit` from `offset`.
    pub async fn threads(
        &self,
        range: SpendRange,
        limit: i64,
        offset: i64,
    ) -> anyhow::Result<ThreadSpendPage> {
        let (from, to) = (DbDateTime(range.from), DbDateTime(range.to));
        let owner = owner();
        let read_owner = owner.clone();
        let rows: Vec<(
            Option<String>,
            Sums,
            Option<DateTime<Utc>>,
            Option<DateTime<Utc>>,
        )> = crate::db::read(move |conn| {
            Ok(l::llm_calls
                .filter(l::agent_id.eq(&read_owner))
                .filter(l::thread_id.is_not_null())
                .filter(l::created_at.ge(from))
                .filter(l::created_at.lt(to))
                .group_by(l::thread_id)
                .select((
                    l::thread_id,
                    sums!(),
                    first_at(l::created_at),
                    last_at(l::created_at),
                ))
                .order_by((cost_sum(l::cost_micro_usd).desc(), l::thread_id.asc()))
                .offset(offset)
                .limit(limit + 1)
                .load(conn)?)
        })
        .await?;
        let page: Vec<_> = rows.iter().take(limit as usize).cloned().collect();
        let ids: Vec<String> = page.iter().filter_map(|row| row.0.clone()).collect();

        let (titles, requests) = {
            let ids = ids.clone();
            crate::db::read(move |conn| {
                let titles: Vec<(String, Option<String>)> = conversation_threads::table
                    .filter(conversation_threads::id.eq_any(&ids))
                    .select((conversation_threads::id, conversation_threads::title))
                    .load(conn)?;
                // The page's requests are grouped and counted here.
                let requests: Vec<(Option<String>, Option<String>)> = l::llm_calls
                    .filter(l::agent_id.eq(&owner))
                    .filter(l::thread_id.eq_any(&ids))
                    .filter(l::request_id.is_not_null())
                    .filter(l::created_at.ge(from))
                    .filter(l::created_at.lt(to))
                    .group_by((l::thread_id, l::request_id))
                    .select((l::thread_id, l::request_id))
                    .load(conn)?;
                Ok((titles, requests))
            })
            .await?
        };
        let titles: HashMap<String, Option<String>> = titles.into_iter().collect();
        let mut request_counts: HashMap<String, i64> = HashMap::new();
        for (thread_id, _) in requests {
            if let Some(thread_id) = thread_id {
                *request_counts.entry(thread_id).or_default() += 1;
            }
        }

        Ok(ThreadSpendPage {
            threads: page
                .into_iter()
                .filter_map(|(thread_id, sums, first, last)| {
                    let thread_id = thread_id?;
                    Some(ThreadSpend {
                        title: titles.get(&thread_id).cloned().flatten(),
                        requests: request_counts.get(&thread_id).copied().unwrap_or(0),
                        first_call_at: first.map(|at| iso(&at)).unwrap_or_default(),
                        last_call_at: last.map(|at| iso(&at)).unwrap_or_default(),
                        totals: totals_of_row(&sums),
                        thread_id,
                    })
                })
                .collect(),
            next_offset: (rows.len() as i64 > limit).then_some(offset + limit),
        })
    }

    /// One thread's totals and its requests, newest first, or `None` for a thread
    /// with no calls.
    pub async fn thread(&self, thread_id: &str) -> anyhow::Result<Option<ThreadSpendDetail>> {
        let breakdown = breakdown(Scope::Thread(thread_id.to_string())).await?;
        if breakdown.totals.calls == 0 {
            return Ok(None);
        }

        let (owner, thread) = (owner(), thread_id.to_string());
        let (request_rows, stored, messages) = crate::db::read(move |conn| {
            let request_rows: Vec<(Option<String>, Sums, Option<DateTime<Utc>>, Option<String>)> =
                l::llm_calls
                    .filter(l::agent_id.eq(&owner))
                    .filter(l::thread_id.eq(&thread))
                    .filter(l::request_id.is_not_null())
                    .group_by(l::request_id)
                    .select((
                        l::request_id,
                        sums!(),
                        first_at(l::created_at),
                        min_text(l::source_kind),
                    ))
                    .order_by(first_at(l::created_at).desc())
                    .load(conn)?;
            let stored: Option<(Option<String>, ThreadSource, Option<String>)> =
                conversation_threads::table
                    .filter(conversation_threads::id.eq(&thread))
                    .select((
                        conversation_threads::title,
                        conversation_threads::thread_source,
                        conversation_threads::external_thread_id,
                    ))
                    .first(conn)
                    .optional()?;
            let ids: Vec<String> = request_rows
                .iter()
                .filter_map(|row| row.0.clone())
                .collect();
            let messages: Vec<(String, String, String)> = conversation_messages::table
                .filter(conversation_messages::id.eq_any(&ids))
                .filter(conversation_messages::thread_id.eq(&thread))
                .select((
                    conversation_messages::id,
                    conversation_messages::content,
                    conversation_messages::triggered_by,
                ))
                .load(conn)?;
            Ok((request_rows, stored, messages))
        })
        .await?;
        let messages: HashMap<String, (String, String)> = messages
            .into_iter()
            .map(|(id, content, triggered_by)| (id, (content, triggered_by)))
            .collect();

        let (title, opens_in_chat) = match stored {
            Some((title, source, external)) => (title, is_web_thread(source, external.as_deref())),
            None => (None, false),
        };
        Ok(Some(ThreadSpendDetail {
            thread_id: thread_id.to_string(),
            title,
            opens_in_chat,
            breakdown,
            requests: request_rows
                .into_iter()
                .filter_map(|(request_id, sums, first, source_kind)| {
                    let request_id = request_id?;
                    let message = messages.get(&request_id);
                    let kind = request_kind(
                        message.map(|(_, triggered_by)| triggered_by.as_str()),
                        source_kind.as_deref(),
                    );
                    let preview = message
                        .filter(|_| kind != "task-result")
                        .map(|(content, _)| preview_of(content));
                    Some(RequestSpend {
                        request_id,
                        kind,
                        preview,
                        first_call_at: first.map(|at| iso(&at)).unwrap_or_default(),
                        totals: totals_of_row(&sums),
                    })
                })
                .collect(),
        }))
    }

    /// One request's totals, or `None` for a request with no calls.
    pub async fn request(&self, request_id: &str) -> anyhow::Result<Option<RequestSpendDetail>> {
        let breakdown = breakdown(Scope::Request(request_id.to_string())).await?;
        if breakdown.totals.calls == 0 {
            return Ok(None);
        }
        let (owner, request) = (owner(), request_id.to_string());
        let thread_id: Option<Option<String>> = crate::db::read(move |conn| {
            Ok(l::llm_calls
                .filter(l::agent_id.eq(&owner))
                .filter(l::request_id.eq(&request))
                .filter(l::thread_id.is_not_null())
                .select(l::thread_id)
                .first(conn)
                .optional()?)
        })
        .await?;
        Ok(Some(RequestSpendDetail {
            request_id: request_id.to_string(),
            thread_id: thread_id.flatten(),
            breakdown,
        }))
    }

    /// A category's spend in `range` per scheduled task, webhook or goal, most spent first.
    pub async fn sources(
        &self,
        category: SourcedCategory,
        range: SpendRange,
    ) -> anyhow::Result<Vec<SourceSpend>> {
        let (owner, from, to) = (owner(), DbDateTime(range.from), DbDateTime(range.to));
        let rows: Vec<(String, Option<String>, Option<String>, Sums)> =
            crate::db::read(move |conn| {
                Ok(l::llm_calls
                    .filter(l::agent_id.eq(&owner))
                    .filter(l::created_at.ge(from))
                    .filter(l::created_at.lt(to))
                    .group_by((l::purpose, l::source_kind, l::source_id))
                    .select((l::purpose, l::source_kind, l::source_id, sums!()))
                    .load(conn)?)
            })
            .await?;
        let mut groups: IndexMap<Option<String>, Accumulator> = IndexMap::new();
        for (purpose, source_kind, source_id, sums) in &rows {
            if category_of(purpose, source_kind.as_deref()) == category.category() {
                add_to(&mut groups, source_id.clone(), sums);
            }
        }
        let ids: Vec<String> = groups.keys().flatten().cloned().collect();
        let names = source_names(category, ids).await?;

        Ok(ranked(&groups, |source_id: Option<String>, totals| {
            SourceSpend {
                name: source_id.as_ref().and_then(|id| names.get(id).cloned()),
                source_id,
                totals,
            }
        }))
    }
}

async fn source_names(
    category: SourcedCategory,
    ids: Vec<String>,
) -> anyhow::Result<HashMap<String, String>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    crate::db::read(move |conn| {
        let names: Vec<(String, String)> = match category {
            SourcedCategory::ScheduledTasks => cron_tasks::table
                .filter(cron_tasks::id.eq_any(&ids))
                .select((cron_tasks::id, cron_tasks::name))
                .load(conn)?,
            SourcedCategory::Webhooks => webhook_subscriptions::table
                .filter(webhook_subscriptions::id.eq_any(&ids))
                .select((webhook_subscriptions::id, webhook_subscriptions::name))
                .load(conn)?,
            SourcedCategory::Goals => goals::table
                .filter(goals::id.eq_any(&ids))
                .select((goals::id, goals::objective))
                .load::<(String, String)>(conn)?
                .into_iter()
                .map(|(id, objective)| (id, preview_of(&objective)))
                .collect(),
        };
        Ok(names.into_iter().collect())
    })
    .await
}

async fn breakdown(scope: Scope) -> anyhow::Result<SpendBreakdown> {
    let owner = owner();
    let rows: Vec<BreakdownRow> = crate::db::read(move |conn| {
        let owned = l::llm_calls.filter(l::agent_id.eq(owner));
        macro_rules! grouped {
            ($query:expr) => {
                $query
                    .group_by((l::purpose, l::model, l::source_kind))
                    .select((l::purpose, l::model, l::source_kind, sums!()))
                    .load(conn)?
            };
        }
        Ok(match scope {
            Scope::Range(range) => grouped!(
                owned
                    .filter(l::created_at.ge(DbDateTime(range.from)))
                    .filter(l::created_at.lt(DbDateTime(range.to)))
            ),
            Scope::Thread(thread_id) => grouped!(owned.filter(l::thread_id.eq(thread_id))),
            Scope::Request(request_id) => grouped!(owned.filter(l::request_id.eq(request_id))),
        })
    })
    .await?;

    let mut total = Accumulator::default();
    let mut by_kind: IndexMap<SpendKind, Accumulator> = IndexMap::new();
    let mut by_category: IndexMap<SpendCategory, Accumulator> = IndexMap::new();
    let mut by_model: IndexMap<String, Accumulator> = IndexMap::new();
    let mut by_purpose: IndexMap<String, Accumulator> = IndexMap::new();
    for (purpose, model, source_kind, sums) in &rows {
        total.add(sums);
        add_to(&mut by_kind, spend_kind_of(purpose), sums);
        add_to(
            &mut by_category,
            category_of(purpose, source_kind.as_deref()),
            sums,
        );
        add_to(&mut by_model, model.clone(), sums);
        add_to(&mut by_purpose, purpose.clone(), sums);
    }

    Ok(SpendBreakdown {
        totals: total.totals(),
        by_kind: ranked(&by_kind, |kind, totals| KindSpend { kind, totals }),
        by_category: ranked(&by_category, |category, totals| CategorySpend {
            category,
            totals,
        }),
        by_model: ranked(&by_model, |model, totals| ModelSpend { model, totals }),
        by_purpose: ranked(&by_purpose, |purpose, totals| PurposeSpend {
            purpose,
            totals,
        }),
    })
}

pub static SPENDING_SERVICE: LazyLock<SpendingService> = LazyLock::new(|| SpendingService);

#[cfg(test)]
mod tests {
    //! Spending reads over `llm_calls` in a database built from the committed
    //! migrations, so the grouping, the indexes and the stored buckets are the real ones.

    use super::*;
    use crate::db::models::{
        MessageRole, MessageTrigger, NewConversationMessage, NewConversationThread, NewCronTask,
        NewLlmCall, llm_call_bucket,
    };
    use crate::db::testing::{TestDb, test_db};
    use crate::support::parse_iso;

    const OTHER_AGENT: &str = "agent-2";

    fn owner_id() -> String {
        owner()
    }

    #[derive(Default)]
    struct Call {
        at: &'static str,
        purpose: Option<&'static str>,
        model: Option<&'static str>,
        /// `None` is the default 1000; `Some(None)` is unpriced.
        cost: Option<Option<i64>>,
        thread_id: Option<&'static str>,
        request_id: Option<&'static str>,
        agent_id: Option<&'static str>,
        source_kind: Option<&'static str>,
        source_id: Option<&'static str>,
    }

    fn call(at: &'static str, cost: Option<i64>) -> Call {
        Call {
            at,
            cost: Some(cost),
            ..Call::default()
        }
    }

    async fn record(calls: Vec<Call>) {
        let rows: Vec<NewLlmCall> = calls
            .into_iter()
            .map(|call| {
                let at = parse_iso(call.at).unwrap();
                let mut row = NewLlmCall::new(
                    call.agent_id.map(str::to_string).unwrap_or_else(owner_id),
                    call.purpose.unwrap_or("chat"),
                    call.model.unwrap_or("claude-opus-5"),
                );
                row.thread_id = call.thread_id.map(str::to_string);
                row.request_id = call.request_id.map(str::to_string);
                row.source_kind = call.source_kind.map(str::to_string);
                row.source_id = call.source_id.map(str::to_string);
                row.input_tokens = 100;
                row.output_tokens = 10;
                let cost = call.cost.unwrap_or(Some(1000));
                row.cost_micro_usd = cost;
                row.cost_source = cost.map(|_| "catalog".to_string());
                row.created_at = at.into();
                row.bucket = llm_call_bucket(at).into();
                row
            })
            .collect();
        crate::db::run(move |conn| {
            diesel::insert_into(l::llm_calls)
                .values(&rows)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    fn setup() -> TestDb {
        let db = test_db();
        crate::services::memory_store::tests::ensure_agent(&owner_id());
        crate::services::memory_store::tests::ensure_agent(OTHER_AGENT);
        db
    }

    fn range(from: &str, to: &str) -> SpendRange {
        SpendRange {
            from: parse_iso(from).unwrap(),
            to: parse_iso(to).unwrap(),
        }
    }

    fn ms(text: &str) -> i64 {
        parse_iso(text).unwrap().timestamp_millis()
    }

    async fn thread_row(id: &str, title: Option<&str>) {
        let mut thread = NewConversationThread::new(owner_id(), "user-1");
        thread.id = id.to_string();
        thread.title = title.map(str::to_string);
        crate::db::run(move |conn| {
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn adds_up_the_range_by_spend_kind_model_and_purpose_and_counts_the_unpriced_calls_apart()
    {
        let _db = setup();
        record(vec![
            call("2026-11-20T10:00:00Z", Some(2500)),
            Call {
                purpose: Some("compaction"),
                ..call("2026-11-20T10:01:00Z", Some(500))
            },
            Call {
                purpose: Some("coding-agent"),
                model: Some("claude-sonnet-5-5"),
                ..call("2026-11-20T10:02:00Z", Some(4000))
            },
            Call {
                purpose: Some("coding-agent"),
                model: Some("codex"),
                ..call("2026-11-20T10:03:00Z", None)
            },
            Call {
                purpose: Some("voice-chat"),
                model: Some("gpt-realtime-2.1"),
                ..call("2026-11-20T10:04:00Z", Some(1250))
            },
            // Outside the range, and another agent's.
            call("2026-11-19T09:59:59Z", Some(99_000)),
            Call {
                agent_id: Some(OTHER_AGENT),
                ..call("2026-11-20T10:05:00Z", Some(99_000))
            },
        ])
        .await;

        let spend = SPENDING_SERVICE
            .summary(range("2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z"))
            .await
            .unwrap();

        assert_eq!(
            (
                spend.totals.cost_usd,
                spend.totals.calls,
                spend.totals.unpriced_calls,
                spend.totals.input_tokens
            ),
            (0.00825, 5, 1, 500)
        );
        let kinds: Vec<(SpendKind, f64, i64, i64)> = spend
            .by_kind
            .iter()
            .map(|k| {
                (
                    k.kind,
                    k.totals.cost_usd,
                    k.totals.calls,
                    k.totals.unpriced_calls,
                )
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                (SpendKind::CodingAgent, 0.004, 2, 1),
                (SpendKind::Main, 0.003, 2, 0),
                (SpendKind::Voice, 0.00125, 1, 0),
            ]
        );
        let purposes: Vec<&str> = spend
            .by_purpose
            .iter()
            .map(|p| p.purpose.as_str())
            .collect();
        assert_eq!(
            purposes,
            ["coding-agent", "chat", "voice-chat", "compaction"]
        );
        // The calls have no source, as calls recorded before sources were stored: a chat
        // step is a conversation, and a compaction with no request is background work.
        let categories: Vec<(SpendCategory, f64)> = spend
            .by_category
            .iter()
            .map(|c| (c.category, c.totals.cost_usd))
            .collect();
        assert_eq!(
            categories,
            vec![
                (SpendCategory::CodingAgent, 0.004),
                (SpendCategory::Conversations, 0.0025),
                (SpendCategory::Voice, 0.00125),
                (SpendCategory::Background, 0.0005),
            ]
        );
        let opus = spend
            .by_model
            .iter()
            .find(|m| m.model == "claude-opus-5")
            .unwrap();
        assert_eq!((opus.totals.cost_usd, opus.totals.calls), (0.003, 2));
        assert_eq!(
            serde_json::to_value(&spend.by_kind[0]).unwrap(),
            serde_json::json!({
                "kind": "coding-agent", "costUsd": 0.004, "calls": 2, "unpricedCalls": 1,
                "inputTokens": 200, "outputTokens": 20, "cacheReadTokens": 0, "cacheWriteTokens": 0,
            })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn splits_days_at_local_midnight_a_daylight_saving_change_included() {
        let _db = setup();
        // Helsinki leaves summer time on 25 October 2026, so that day is 25 hours long.
        record(vec![
            call("2026-10-24T20:59:00Z", Some(1)), // 23:59 on the 24th, local
            call("2026-10-24T21:00:00Z", Some(10)), // 00:00 on the 25th
            call("2026-10-25T21:59:00Z", Some(100)), // 23:59 on the 25th, after the change
            call("2026-10-25T22:00:00Z", Some(1000)), // 00:00 on the 26th
            Call {
                purpose: Some("coding-agent"),
                ..call("2026-10-26T10:00:00Z", Some(5000))
            },
        ])
        .await;

        let days = SPENDING_SERVICE
            .periods(
                SpendPeriod::Day,
                3,
                "Europe/Helsinki",
                ms("2026-10-26T12:00:00Z"),
            )
            .await
            .unwrap();

        let shown: Vec<(&str, &str, &str, f64, i64)> = days
            .iter()
            .map(|d| {
                (
                    d.start.as_str(),
                    d.from.as_str(),
                    d.to.as_str(),
                    d.totals.cost_usd,
                    d.totals.calls,
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                (
                    "2026-10-24",
                    "2026-10-23T21:00:00.000Z",
                    "2026-10-24T21:00:00.000Z",
                    0.000001,
                    1
                ),
                (
                    "2026-10-25",
                    "2026-10-24T21:00:00.000Z",
                    "2026-10-25T22:00:00.000Z",
                    0.00011,
                    2
                ),
                (
                    "2026-10-26",
                    "2026-10-25T22:00:00.000Z",
                    "2026-10-26T22:00:00.000Z",
                    0.006,
                    2
                ),
            ]
        );
        assert_eq!(
            serde_json::to_value(days[2].cost_usd_by_kind).unwrap(),
            serde_json::json!({ "main": 0.001, "coding-agent": 0.005, "voice": 0 })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn starts_a_week_on_monday_and_a_month_on_its_first_day_and_lists_empty_periods() {
        let _db = setup();
        record(vec![
            call("2026-11-16T00:30:00Z", Some(3000)),
            call("2026-09-30T23:59:00Z", Some(7000)),
        ])
        .await;
        let now = ms("2026-11-21T12:00:00Z"); // a Saturday

        let weeks = SPENDING_SERVICE
            .periods(SpendPeriod::Week, 2, "UTC", now)
            .await
            .unwrap();
        let shown: Vec<(&str, f64)> = weeks
            .iter()
            .map(|w| (w.start.as_str(), w.totals.cost_usd))
            .collect();
        assert_eq!(shown, vec![("2026-11-09", 0.0), ("2026-11-16", 0.003)]);

        let months = SPENDING_SERVICE
            .periods(SpendPeriod::Month, 3, "UTC", now)
            .await
            .unwrap();
        let shown: Vec<(&str, f64)> = months
            .iter()
            .map(|m| (m.start.as_str(), m.totals.cost_usd))
            .collect();
        assert_eq!(
            shown,
            vec![
                ("2026-09-01", 0.007),
                ("2026-10-01", 0.0),
                ("2026-11-01", 0.003)
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn ranks_the_threads_by_spend_with_their_titles_a_page_at_a_time() {
        let _db = setup();
        thread_row("thread-a", Some("Fix the build")).await;
        record(vec![
            Call {
                thread_id: Some("thread-a"),
                request_id: Some("message-1"),
                ..call("2026-11-20T10:00:00Z", Some(1000))
            },
            Call {
                thread_id: Some("thread-a"),
                request_id: Some("message-2"),
                ..call("2026-11-20T11:00:00Z", Some(1000))
            },
            Call {
                thread_id: Some("thread-b"),
                ..call("2026-11-20T10:30:00Z", Some(5000))
            },
            Call {
                thread_id: Some("thread-c"),
                ..call("2026-11-20T10:30:00Z", Some(100))
            },
            call("2026-11-20T10:30:00Z", Some(50_000)),
        ])
        .await;
        let day = range("2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z");

        let first = SPENDING_SERVICE.threads(day, 2, 0).await.unwrap();
        let shown: Vec<(&str, Option<&str>, f64, i64)> = first
            .threads
            .iter()
            .map(|t| {
                (
                    t.thread_id.as_str(),
                    t.title.as_deref(),
                    t.totals.cost_usd,
                    t.totals.calls,
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                ("thread-b", None, 0.005, 1),
                ("thread-a", Some("Fix the build"), 0.002, 2)
            ]
        );
        assert_eq!(
            (
                first.threads[1].requests,
                first.threads[1].first_call_at.as_str(),
                first.threads[1].last_call_at.as_str()
            ),
            (2, "2026-11-20T10:00:00.000Z", "2026-11-20T11:00:00.000Z")
        );
        assert_eq!(first.next_offset, Some(2));

        let second = SPENDING_SERVICE.threads(day, 2, 2).await.unwrap();
        let ids: Vec<&str> = second
            .threads
            .iter()
            .map(|t| t.thread_id.as_str())
            .collect();
        assert_eq!(ids, ["thread-c"]);
        assert_eq!(second.next_offset, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn lists_a_threads_requests_newest_first_with_what_each_one_was_and_reads_one_request() {
        let _db = setup();
        thread_row("thread-a", None).await;
        let mut typed = NewConversationMessage::new(
            "thread-a",
            MessageRole::User,
            "Fix   the\nflaky test in CI",
            MessageTrigger::UserInput,
        );
        typed.id = "message-1".into();
        let mut task = NewConversationMessage::new(
            "thread-a",
            MessageRole::User,
            "<task-notification>…",
            MessageTrigger::TaskNotification,
        );
        task.id = "task-1".into();
        crate::db::run(move |conn| {
            diesel::insert_into(conversation_messages::table)
                .values(&vec![typed, task])
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        record(vec![
            Call {
                thread_id: Some("thread-a"),
                request_id: Some("task-1"),
                source_kind: Some("chat"),
                ..call("2026-11-20T10:06:00Z", Some(200))
            },
            Call {
                thread_id: Some("thread-a"),
                request_id: Some("run-1"),
                source_kind: Some("cron"),
                source_id: Some("cron-1"),
                purpose: Some("cron"),
                ..call("2026-11-20T10:07:00Z", Some(50))
            },
            Call {
                thread_id: Some("thread-a"),
                request_id: Some("message-2"),
                ..call("2026-11-20T10:05:00Z", Some(300))
            },
            Call {
                thread_id: Some("thread-a"),
                request_id: Some("message-1"),
                ..call("2026-11-20T10:00:00Z", Some(1000))
            },
            Call {
                thread_id: Some("thread-a"),
                request_id: Some("message-1"),
                purpose: Some("coding-agent"),
                model: Some("claude-sonnet-5-5"),
                ..call("2026-11-20T10:01:00Z", Some(4000))
            },
            Call {
                thread_id: Some("thread-a"),
                purpose: Some("thread-title"),
                ..call("2026-11-20T10:02:00Z", Some(10))
            },
        ])
        .await;

        let thread = SPENDING_SERVICE.thread("thread-a").await.unwrap().unwrap();
        assert_eq!(
            (
                thread.thread_id.as_str(),
                thread.breakdown.totals.cost_usd,
                thread.breakdown.totals.calls
            ),
            ("thread-a", 0.00556, 6)
        );
        let requests: Vec<(&str, &str, Option<&str>, f64, i64)> = thread
            .requests
            .iter()
            .map(|r| {
                (
                    r.request_id.as_str(),
                    r.kind.as_str(),
                    r.preview.as_deref(),
                    r.totals.cost_usd,
                    r.totals.calls,
                )
            })
            .collect();
        assert_eq!(
            requests,
            vec![
                ("run-1", "cron", None, 0.00005, 1),
                ("task-1", "task-result", None, 0.0002, 1),
                // A message whose row is gone is still listed, without a preview.
                ("message-2", "other", None, 0.0003, 1),
                (
                    "message-1",
                    "message",
                    Some("Fix the flaky test in CI"),
                    0.005,
                    2
                ),
            ]
        );

        let request = SPENDING_SERVICE
            .request("message-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                request.request_id.as_str(),
                request.thread_id.as_deref(),
                request.breakdown.totals.cost_usd,
                request.breakdown.totals.calls
            ),
            ("message-1", Some("thread-a"), 0.005, 2)
        );
        let kinds: Vec<SpendKind> = request.breakdown.by_kind.iter().map(|k| k.kind).collect();
        assert_eq!(kinds, [SpendKind::CodingAgent, SpendKind::Main]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn lists_a_categorys_spend_per_scheduled_task_with_each_tasks_name() {
        let _db = setup();
        let mut task = NewCronTask::new(
            owner_id(),
            "user-1",
            "Nightly report",
            "0 2 * * *",
            "Report",
        );
        task.id = "cron-1".into();
        crate::db::run(move |conn| {
            diesel::insert_into(cron_tasks::table)
                .values(&task)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        let sourced = |at, purpose, source_kind, source_id, cost| Call {
            purpose: Some(purpose),
            source_kind,
            source_id,
            ..call(at, Some(cost))
        };
        record(vec![
            sourced(
                "2026-11-20T02:00:00Z",
                "cron",
                Some("cron"),
                Some("cron-1"),
                3000,
            ),
            sourced(
                "2026-11-20T02:00:01Z",
                "risk-gate",
                Some("cron"),
                Some("cron-1"),
                100,
            ),
            // The coding task a scheduled run started is coding-agent spend, not the task's.
            sourced(
                "2026-11-20T02:00:02Z",
                "coding-agent",
                Some("cron"),
                Some("cron-1"),
                9000,
            ),
            sourced(
                "2026-11-20T03:00:00Z",
                "cron",
                Some("cron"),
                Some("deleted-task"),
                500,
            ),
            sourced("2026-11-19T03:00:00Z", "cron", None, None, 200),
            sourced(
                "2026-11-20T04:00:00Z",
                "heartbeat",
                Some("heartbeat"),
                None,
                700,
            ),
        ])
        .await;

        let sources = SPENDING_SERVICE
            .sources(
                SourcedCategory::ScheduledTasks,
                range("2026-11-19T00:00:00Z", "2026-11-21T00:00:00Z"),
            )
            .await
            .unwrap();

        let shown: Vec<(Option<&str>, Option<&str>, f64, i64)> = sources
            .iter()
            .map(|s| {
                (
                    s.source_id.as_deref(),
                    s.name.as_deref(),
                    s.totals.cost_usd,
                    s.totals.calls,
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                (Some("cron-1"), Some("Nightly report"), 0.0031, 2),
                (Some("deleted-task"), None, 0.0005, 1),
                (None, None, 0.0002, 1),
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn opens_only_a_web_thread_in_chat() {
        let _db = setup();
        let threads = [
            ("web", ThreadSource::Database, None),
            // A channel's thread with stored history: the source is the database, the id is the channel's.
            (
                "stored-channel",
                ThreadSource::Database,
                Some("1700000000.000100"),
            ),
            (
                "live-channel",
                ThreadSource::Slack,
                Some("1700000000.000200"),
            ),
        ];
        for (id, source, external) in threads {
            let mut thread = NewConversationThread::new(owner_id(), "user-1");
            thread.id = id.to_string();
            thread.thread_source = source;
            thread.external_thread_id = external.map(str::to_string);
            crate::db::run(move |conn| {
                diesel::insert_into(conversation_threads::table)
                    .values(&thread)
                    .execute(conn)?;
                Ok(())
            })
            .await
            .unwrap();
        }
        record(vec![
            Call {
                thread_id: Some("web"),
                request_id: Some("r-1"),
                ..call("2026-11-20T10:00:00Z", Some(10))
            },
            Call {
                thread_id: Some("stored-channel"),
                request_id: Some("r-2"),
                ..call("2026-11-20T10:00:00Z", Some(10))
            },
            Call {
                thread_id: Some("live-channel"),
                request_id: Some("r-3"),
                ..call("2026-11-20T10:00:00Z", Some(10))
            },
        ])
        .await;

        for (id, opens) in [
            ("web", true),
            ("stored-channel", false),
            ("live-channel", false),
        ] {
            let thread = SPENDING_SERVICE.thread(id).await.unwrap().unwrap();
            assert_eq!(thread.opens_in_chat, opens, "{id}");
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_none_for_a_thread_or_a_request_with_no_calls() {
        let _db = setup();
        assert!(SPENDING_SERVICE.thread("nothing").await.unwrap().is_none());
        assert!(SPENDING_SERVICE.request("nothing").await.unwrap().is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_rows_whose_dates_the_prisma_client_wrote() {
        // The e2e steps write rows through Prisma, which stores a DateTime as epoch
        // milliseconds; the migration's own default writes text.
        let _db = setup();
        let owner = owner_id();
        crate::db::run(move |conn| {
            diesel::sql_query(format!(
                r#"INSERT INTO "llm_calls" ("id", "agentId", "purpose", "model", "requestId", "costMicroUsd", "createdAt", "bucket")
                   VALUES ('p1', '{owner}', 'chat', 'm', 'message-9', 700, 1795257899999, 1795257000000),
                          ('p2', '{owner}', 'chat', 'm', 'message-9', 300, '2026-11-21 10:40:00', '2026-11-21 10:30:00')"#
            ))
            .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();

        let request = SPENDING_SERVICE
            .request("message-9")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                request.breakdown.totals.cost_usd,
                request.breakdown.totals.calls
            ),
            (0.001, 2)
        );
        let day = SPENDING_SERVICE
            .periods(SpendPeriod::Day, 1, "UTC", ms("2026-11-21T12:00:00Z"))
            .await
            .unwrap();
        assert_eq!(day[0].totals.calls, 1);
    }

    #[test]
    fn previews_a_message_on_one_line_cut_at_120_characters() {
        assert_eq!(
            preview_of("  Fix   the\nflaky test  "),
            "Fix the flaky test"
        );
        let long = "a".repeat(130);
        let preview = preview_of(&long);
        assert_eq!(preview, format!("{}…", "a".repeat(119)));
    }

    #[test]
    fn files_each_call_under_the_category_of_what_started_it() {
        assert_eq!(
            category_of("coding-agent", Some("cron")),
            SpendCategory::CodingAgent
        );
        assert_eq!(category_of("meeting", None), SpendCategory::Voice);
        assert_eq!(
            category_of("risk-gate", Some("cron")),
            SpendCategory::ScheduledTasks
        );
        assert_eq!(category_of("cron", None), SpendCategory::ScheduledTasks);
        assert_eq!(category_of("compaction", None), SpendCategory::Background);
        assert_eq!(
            category_of("compaction", Some("unknown")),
            SpendCategory::Background
        );
        assert_eq!(
            category_of("chat", Some("voice-chat")),
            SpendCategory::Voice
        );
    }
}
