# AGENTS.md

Guidance for AI coding agents making MCP-facing changes in this repository.

## Scope

This project exposes an email MCP server on Cloudflare Workers. Treat tool names,
tool descriptions, Zod input descriptions, output schemas, and annotations as part
of the product interface. Small wording changes can affect whether AI clients choose
the right tool.

Most MCP tool definitions live in `src/index.ts`. Mail behavior lives under
`src/mail/`.

## MCP Tool Design

- Use action-oriented `domain_verb_noun` names, with `email_` first for email
  tools. Prefer names like `email_search_messages`, `email_get_message`, and
  `email_create_message_draft`.
- Keep naming consistent across tools, parameters, descriptions, README text, and
  output schemas. If the operation is called `archive`, use "archive" everywhere.
- Put the most important disambiguating word early. For this repo, that usually
  means starting tool names with `email_`.
- Avoid broad or ambiguous names such as `search`, `emails`, `mail`, `get`, or
  `taskManager`.
- When adding related tools, make the family inferable from existing names. For
  example, a new read operation should feel related to `email_search_messages`,
  `email_get_message`, and `email_get_message_thread`.

## Tool Descriptions

Write descriptions for model selection, not only human documentation. A good tool
description should state:

- The action the tool performs, using common synonyms naturally such as find,
  search, lookup, locate, show, check, move, send, or delete where relevant.
- The required prerequisite or previous tool result, such as "using the UID returned
  by `email_search_messages`".
- The expected output shape, including IDs, sender, recipients, subject, dates,
  snippets, flags, attachment metadata, account identity, or folder names.
- When not to use the tool. For example, "Do not use for searching" on a getter, or
  "Use `email_search_messages` first to locate messages" on a mutation.
- Side effects for every write operation, including whether it creates a draft,
  sends mail, moves messages, changes flags, removes local configuration, trashes
  messages, or permanently deletes provider data.

Prefer concrete descriptions like:

```ts
description:
	"Find, search, or locate emails in one configured account by sender, recipient, subject, keywords, dates, flags, or attachment state. Returns folder, UID, message IDs, sender, recipients, subject, date, flags, and snippets. Use email_get_message afterwards to retrieve the full body.",
```

Avoid descriptions like:

```ts
description: "Searches emails.",
```

## Parameter Descriptions

Parameter descriptions matter as much as tool descriptions. When adding or changing
input schemas:

- Describe where IDs come from. Example: "The email message UID returned by
  `email_search_messages`."
- Mention accepted query syntax or filters explicitly.
- Distinguish optional single-account parameters from all-account behavior.
- Document limits, defaults, and exact semantics for state filters.
- Use precise names such as `accountId`, `accountIds`, `folder`, `uid`, `messageId`,
  `draftUid`, and `attachmentPartId`.

Avoid vague parameter descriptions such as "id", "query", or "folder name" when
the model needs to know how to obtain or use the value.

## Chaining

Make normal tool chains obvious in metadata and docs:

- Use `email_list_accounts` before tools that require an `accountId` when the
  account is unknown.
- Use `email_list_folders` before folder-scoped operations when the exact folder
  path is unknown.
- Use `email_search_messages` or `email_search_all_accounts` to locate messages.
- Use `email_get_message` to retrieve the full body after search returns a folder
  and UID.
- Use `email_get_message_attachment` only after a message or search result exposes
  attachment metadata.
- Use draft tools before `email_send_draft`; be clear when a tool creates or updates
  a draft without sending.

When a new tool fits into a sequence, say so in the description.

## Side Effects And Safety

Be especially explicit for write tools:

- "Creates a draft without sending" is different from "Sends an email".
- "Moves to trash" is different from "Permanently deletes".
- "Removes local account configuration" is different from deleting mailbox messages
  at the provider.
- Flag changes, moves, deletes, sends, and credential changes must have accurate MCP
  annotations.

Do not weaken safety wording to make descriptions shorter.

## Outputs

Every tool should publish an MCP output schema and return validated
`structuredContent`. Keep the JSON text compatibility copy unless intentionally
changing that project-wide convention.

When adding a tool, describe outputs in both the schema and the tool description
well enough for a model to decide whether another tool call is required.

## Examples

For search-like tools, include useful examples in descriptions or README updates
when they clarify selection:

- `from:govee newer_than:30d`
- `subject:"Invoice"`
- `has:attachment PDF`
- sender, recipient, subject, keyword, date range, attachment, and flag examples

Keep examples realistic for email use.

## Verification

Before finishing MCP changes, run:

```bash
npm test
```

Use `npm run type-check` when you only need TypeScript validation. Update
`README.md` when tool names, behavior, setup, or chaining guidance changes.
