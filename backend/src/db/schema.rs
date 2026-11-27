//! The database tables as Diesel sees them: one `table!` per Prisma model, named by
//! its `@@map`, with the columns in the model's field order so a struct that lists
//! its fields in that order loads with the default select. A column keeps its stored
//! name through `sql_name`.
//!
//! `memory_entry_vec` is the sqlite-vec index `lib::sqlite_bootstrap` builds at
//! runtime; it has no model and no table here.

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    agent_workspaces (id) {
        id -> Text,
        #[sql_name = "userId"]
        user_id -> Text,
        name -> Text,
        #[sql_name = "agentType"]
        agent_type -> Text,
        #[sql_name = "soulMd"]
        soul_md -> Text,
        #[sql_name = "userMd"]
        user_md -> Text,
        #[sql_name = "memoryMd"]
        memory_md -> Text,
        #[sql_name = "heartbeatMd"]
        heartbeat_md -> Text,
        #[sql_name = "visionMd"]
        vision_md -> Text,
        #[sql_name = "agentMd"]
        agent_md -> Text,
        #[sql_name = "bootstrapMd"]
        bootstrap_md -> Text,
        #[sql_name = "heartbeatIntervalMs"]
        heartbeat_interval_ms -> BigInt,
        #[sql_name = "heartbeatStatus"]
        heartbeat_status -> Text,
        #[sql_name = "heartbeatDeliverTo"]
        heartbeat_deliver_to -> Text,
        #[sql_name = "heartbeatChannelIds"]
        heartbeat_channel_ids -> Nullable<Text>,
        timezone -> Text,
        model -> Nullable<Text>,
        #[sql_name = "heartbeatModel"]
        heartbeat_model -> Nullable<Text>,
        #[sql_name = "cronModel"]
        cron_model -> Nullable<Text>,
        #[sql_name = "modelMode"]
        model_mode -> Nullable<Text>,
        #[sql_name = "smallModel"]
        small_model -> Nullable<Text>,
        #[sql_name = "mediumModel"]
        medium_model -> Nullable<Text>,
        #[sql_name = "largeModel"]
        large_model -> Nullable<Text>,
        #[sql_name = "dailyResetHour"]
        daily_reset_hour -> BigInt,
        #[sql_name = "idleTimeoutMins"]
        idle_timeout_mins -> Nullable<BigInt>,
        #[sql_name = "webhooksEnabled"]
        webhooks_enabled -> Bool,
        verbose -> Bool,
        #[sql_name = "lockedIn"]
        locked_in -> Bool,
        #[sql_name = "nexusMcpAgentToken"]
        nexus_mcp_agent_token -> Nullable<Text>,
        #[sql_name = "nexusAgentTokenId"]
        nexus_agent_token_id -> Nullable<Text>,
        status -> Text,
        #[sql_name = "lastHeartbeat"]
        last_heartbeat -> Nullable<PrismaDateTime>,
        #[sql_name = "nextHeartbeatAt"]
        next_heartbeat_at -> Nullable<PrismaDateTime>,
        #[sql_name = "currentSessionId"]
        current_session_id -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    agent_workspace_revisions (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        field -> Text,
        content -> Text,
        actor -> Text,
        method -> Text,
        reason -> Text,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    conversation_threads (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "userId"]
        user_id -> Text,
        title -> Nullable<Text>,
        #[sql_name = "externalThreadId"]
        external_thread_id -> Nullable<Text>,
        #[sql_name = "threadSource"]
        thread_source -> Text,
        #[sql_name = "externalChannelId"]
        external_channel_id -> Nullable<Text>,
        #[sql_name = "workspaceRoot"]
        workspace_root -> Nullable<Text>,
        #[sql_name = "compactionSummary"]
        compaction_summary -> Nullable<Text>,
        #[sql_name = "compactedAt"]
        compacted_at -> Nullable<PrismaDateTime>,
        #[sql_name = "compactedThroughTs"]
        compacted_through_ts -> Nullable<Text>,
        #[sql_name = "contextTokens"]
        context_tokens -> Nullable<BigInt>,
        #[sql_name = "contextModel"]
        context_model -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    conversation_messages (id) {
        id -> Text,
        #[sql_name = "threadId"]
        thread_id -> Text,
        role -> Text,
        content -> Text,
        #[sql_name = "triggeredBy"]
        triggered_by -> Text,
        #[sql_name = "triggerName"]
        trigger_name -> Nullable<Text>,
        #[sql_name = "toolCalls"]
        tool_calls -> Nullable<PrismaJson>,
        blocks -> Nullable<PrismaJson>,
        #[sql_name = "senderExternalId"]
        sender_external_id -> Nullable<Text>,
        #[sql_name = "senderName"]
        sender_name -> Nullable<Text>,
        #[sql_name = "externalMessageId"]
        external_message_id -> Nullable<Text>,
        #[sql_name = "isCompacted"]
        is_compacted -> Bool,
        #[sql_name = "internalStep"]
        internal_step -> Bool,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    message_attachments (id) {
        id -> Text,
        #[sql_name = "messageId"]
        message_id -> Nullable<Text>,
        #[sql_name = "threadId"]
        thread_id -> Nullable<Text>,
        filename -> Text,
        #[sql_name = "mediaType"]
        media_type -> Text,
        #[sql_name = "sizeBytes"]
        size_bytes -> BigInt,
        category -> Text,
        data -> Nullable<Binary>,
        #[sql_name = "storagePath"]
        storage_path -> Nullable<Text>,
        source -> Text,
        #[sql_name = "slackFileId"]
        slack_file_id -> Nullable<Text>,
        #[sql_name = "externalTs"]
        external_ts -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    conversation_participants (id) {
        id -> Text,
        #[sql_name = "threadId"]
        thread_id -> Text,
        #[sql_name = "externalUserId"]
        external_user_id -> Text,
        #[sql_name = "displayName"]
        display_name -> Nullable<Text>,
        channel -> Text,
        #[sql_name = "joinedAt"]
        joined_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    cron_tasks (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "userId"]
        user_id -> Text,
        name -> Text,
        schedule -> Text,
        instruction -> Text,
        #[sql_name = "isActive"]
        is_active -> Bool,
        #[sql_name = "lastRunAt"]
        last_run_at -> Nullable<PrismaDateTime>,
        #[sql_name = "nextRunAt"]
        next_run_at -> Nullable<PrismaDateTime>,
        #[sql_name = "threadId"]
        thread_id -> Nullable<Text>,
        #[sql_name = "originChannel"]
        origin_channel -> Nullable<Text>,
        #[sql_name = "originChannelId"]
        origin_channel_id -> Nullable<Text>,
        #[sql_name = "deliverTo"]
        deliver_to -> Text,
        #[sql_name = "channelIds"]
        channel_ids -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    goals (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "userId"]
        user_id -> Text,
        #[sql_name = "threadId"]
        thread_id -> Text,
        objective -> Text,
        status -> Text,
        #[sql_name = "tokenBudget"]
        token_budget -> Nullable<BigInt>,
        #[sql_name = "tokensUsed"]
        tokens_used -> BigInt,
        #[sql_name = "turnCount"]
        turn_count -> BigInt,
        #[sql_name = "maxTurns"]
        max_turns -> BigInt,
        #[sql_name = "stallCount"]
        stall_count -> BigInt,
        #[sql_name = "lastReason"]
        last_reason -> Nullable<Text>,
        #[sql_name = "originChannel"]
        origin_channel -> Text,
        #[sql_name = "originChannelId"]
        origin_channel_id -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
        #[sql_name = "completedAt"]
        completed_at -> Nullable<PrismaDateTime>,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    llm_calls (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "subagentId"]
        subagent_id -> Nullable<Text>,
        purpose -> Text,
        model -> Text,
        #[sql_name = "threadId"]
        thread_id -> Nullable<Text>,
        #[sql_name = "requestId"]
        request_id -> Nullable<Text>,
        #[sql_name = "sourceKind"]
        source_kind -> Nullable<Text>,
        #[sql_name = "sourceId"]
        source_id -> Nullable<Text>,
        #[sql_name = "totalTokens"]
        total_tokens -> BigInt,
        #[sql_name = "inputTokens"]
        input_tokens -> BigInt,
        #[sql_name = "outputTokens"]
        output_tokens -> BigInt,
        #[sql_name = "cacheReadTokens"]
        cache_read_tokens -> BigInt,
        #[sql_name = "cacheWriteTokens"]
        cache_write_tokens -> BigInt,
        #[sql_name = "noCacheTokens"]
        no_cache_tokens -> BigInt,
        #[sql_name = "audioInputTokens"]
        audio_input_tokens -> BigInt,
        #[sql_name = "audioOutputTokens"]
        audio_output_tokens -> BigInt,
        #[sql_name = "costMicroUsd"]
        cost_micro_usd -> Nullable<BigInt>,
        #[sql_name = "costSource"]
        cost_source -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        bucket -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    memory_entries (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        content -> Text,
        category -> Text,
        importance -> BigInt,
        embedding -> Nullable<Binary>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    slack_mappings (id) {
        id -> Text,
        #[sql_name = "connectionId"]
        connection_id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "slackUserId"]
        slack_user_id -> Nullable<Text>,
        #[sql_name = "lensUserId"]
        lens_user_id -> Nullable<Text>,
        #[sql_name = "dmChannelId"]
        dm_channel_id -> Nullable<Text>,
        #[sql_name = "slackChannelId"]
        slack_channel_id -> Nullable<Text>,
        #[sql_name = "slackChannelName"]
        slack_channel_name -> Nullable<Text>,
        #[sql_name = "isMainChannel"]
        is_main_channel -> Bool,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    slack_verification_codes (id) {
        id -> Text,
        code -> Text,
        #[sql_name = "type"]
        type_ -> Text,
        #[sql_name = "lensUserId"]
        lens_user_id -> Text,
        #[sql_name = "connectionId"]
        connection_id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "agentName"]
        agent_name -> Nullable<Text>,
        #[sql_name = "expiresAt"]
        expires_at -> PrismaDateTime,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    teams_mappings (id) {
        id -> Text,
        #[sql_name = "connectionId"]
        connection_id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "tenantId"]
        tenant_id -> Nullable<Text>,
        #[sql_name = "teamsUserId"]
        teams_user_id -> Nullable<Text>,
        #[sql_name = "lensUserId"]
        lens_user_id -> Nullable<Text>,
        #[sql_name = "dmConversationId"]
        dm_conversation_id -> Nullable<Text>,
        #[sql_name = "channelConversationId"]
        channel_conversation_id -> Nullable<Text>,
        #[sql_name = "channelName"]
        channel_name -> Nullable<Text>,
        #[sql_name = "isMainChannel"]
        is_main_channel -> Bool,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    teams_verification_codes (id) {
        id -> Text,
        code -> Text,
        #[sql_name = "type"]
        type_ -> Text,
        #[sql_name = "lensUserId"]
        lens_user_id -> Text,
        #[sql_name = "connectionId"]
        connection_id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "agentName"]
        agent_name -> Nullable<Text>,
        #[sql_name = "expiresAt"]
        expires_at -> PrismaDateTime,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    agent_subagents (id) {
        id -> Text,
        #[sql_name = "parentAgentId"]
        parent_agent_id -> Text,
        #[sql_name = "childAgentId"]
        child_agent_id -> Text,
        description -> Text,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    slack_heartbeat_triggers (id) {
        id -> Text,
        #[sql_name = "connectionId"]
        connection_id -> Text,
        #[sql_name = "slackChannelId"]
        slack_channel_id -> Text,
        #[sql_name = "slackChannelName"]
        slack_channel_name -> Nullable<Text>,
        #[sql_name = "agentId"]
        agent_id -> Text,
        #[sql_name = "userId"]
        user_id -> Text,
        #[sql_name = "isActive"]
        is_active -> Bool,
        throttle_seconds -> BigInt,
        last_triggered_at -> Nullable<PrismaDateTime>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    pending_slack_messages (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        sender -> Text,
        text -> Text,
        timestamp -> Text,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    webhook_subscriptions (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        name -> Text,
        description -> Nullable<Text>,
        events -> Nullable<Text>,
        prompt -> Nullable<Text>,
        #[sql_name = "deliverTo"]
        deliver_to -> Text,
        #[sql_name = "slackChannelIds"]
        slack_channel_ids -> Nullable<Text>,
        #[sql_name = "deliverOnly"]
        deliver_only -> Bool,
        #[sql_name = "isActive"]
        is_active -> Bool,
        #[sql_name = "coalesceSeconds"]
        coalesce_seconds -> Nullable<BigInt>,
        #[sql_name = "authType"]
        auth_type -> Text,
        #[sql_name = "authHeader"]
        auth_header -> Nullable<Text>,
        #[sql_name = "authPrefix"]
        auth_prefix -> Nullable<Text>,
        #[sql_name = "authAlgorithm"]
        auth_algorithm -> Text,
        #[sql_name = "authEncoding"]
        auth_encoding -> Text,
        #[sql_name = "authSignedUrl"]
        auth_signed_url -> Nullable<Text>,
        secret -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    webhook_runs (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        name -> Text,
        event -> Text,
        status -> Text,
        error -> Nullable<Text>,
        #[sql_name = "messageId"]
        message_id -> Nullable<Text>,
        #[sql_name = "coalescedInto"]
        coalesced_into -> Nullable<Text>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "finishedAt"]
        finished_at -> Nullable<PrismaDateTime>,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    remote_computers (id) {
        id -> Text,
        #[sql_name = "agentId"]
        agent_id -> Text,
        name -> Text,
        #[sql_name = "installationId"]
        installation_id -> Nullable<Text>,
        platform -> Nullable<Text>,
        #[sql_name = "clientVersion"]
        client_version -> Nullable<Text>,
        #[sql_name = "lastConnectedAt"]
        last_connected_at -> Nullable<PrismaDateTime>,
        #[sql_name = "lastSeenAt"]
        last_seen_at -> Nullable<PrismaDateTime>,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    update_attempts (id) {
        id -> Text,
        #[sql_name = "versionFrom"]
        version_from -> Text,
        #[sql_name = "versionTo"]
        version_to -> Text,
        trigger -> Text,
        outcome -> Text,
        #[sql_name = "errorCode"]
        error_code -> Nullable<Text>,
        #[sql_name = "errorDetail"]
        error_detail -> Nullable<Text>,
        #[sql_name = "startedAt"]
        started_at -> PrismaDateTime,
        #[sql_name = "finishedAt"]
        finished_at -> Nullable<PrismaDateTime>,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    runtime_state (key) {
        key -> Text,
        value -> Text,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use crate::db::sql_types::*;

    pending_work (kind, key) {
        kind -> Text,
        key -> Text,
        payload -> PrismaJson,
        attempts -> BigInt,
        #[sql_name = "createdAt"]
        created_at -> PrismaDateTime,
        #[sql_name = "updatedAt"]
        updated_at -> PrismaDateTime,
    }
}

diesel::joinable!(agent_workspace_revisions -> agent_workspaces (agent_id));
diesel::joinable!(conversation_threads -> agent_workspaces (agent_id));
diesel::joinable!(conversation_messages -> conversation_threads (thread_id));
diesel::joinable!(message_attachments -> conversation_messages (message_id));
diesel::joinable!(conversation_participants -> conversation_threads (thread_id));
diesel::joinable!(cron_tasks -> agent_workspaces (agent_id));
diesel::joinable!(cron_tasks -> conversation_threads (thread_id));
diesel::joinable!(goals -> agent_workspaces (agent_id));
diesel::joinable!(goals -> conversation_threads (thread_id));
diesel::joinable!(llm_calls -> agent_workspaces (agent_id));
diesel::joinable!(memory_entries -> agent_workspaces (agent_id));
diesel::joinable!(slack_mappings -> agent_workspaces (agent_id));
diesel::joinable!(slack_verification_codes -> agent_workspaces (agent_id));
diesel::joinable!(teams_mappings -> agent_workspaces (agent_id));
diesel::joinable!(teams_verification_codes -> agent_workspaces (agent_id));
diesel::joinable!(agent_subagents -> agent_workspaces (parent_agent_id));
// `agent_subagents.child_agent_id` references `agent_workspaces` too; Diesel allows one
// `joinable!` per pair of tables.
diesel::joinable!(slack_heartbeat_triggers -> agent_workspaces (agent_id));
diesel::joinable!(pending_slack_messages -> agent_workspaces (agent_id));
diesel::joinable!(webhook_subscriptions -> agent_workspaces (agent_id));
diesel::joinable!(webhook_runs -> agent_workspaces (agent_id));
diesel::joinable!(webhook_runs -> conversation_messages (message_id));
diesel::joinable!(remote_computers -> agent_workspaces (agent_id));

diesel::allow_tables_to_appear_in_same_query!(
    agent_workspaces,
    agent_workspace_revisions,
    conversation_threads,
    conversation_messages,
    message_attachments,
    conversation_participants,
    cron_tasks,
    goals,
    llm_calls,
    memory_entries,
    slack_mappings,
    slack_verification_codes,
    teams_mappings,
    teams_verification_codes,
    agent_subagents,
    slack_heartbeat_triggers,
    pending_slack_messages,
    webhook_subscriptions,
    webhook_runs,
    remote_computers,
    update_attempts,
    runtime_state,
    pending_work,
);
