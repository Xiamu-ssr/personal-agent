# DeepSeek Search connector

Validated 2026-10-21 against the [official Search/Fetch guide](https://api-docs.deepseek.com/zh-cn/guides/search/) and [balance schema](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/).

- `npm test`: 144 passed, 0 failed. Six new tests cover Search/Fetch, Unicode limits, invalid URLs, empty results, balance/account aggregation, private credentials, quota recovery, HTTP form/catalog/icon and dynamic product-tool routing.
- `npm run check`, `node spec/build.mjs`, `git diff --check`: passed; the visual Spec and runtime both list 14 connectors.
- Search/fetch tests use an isolated local HTTP service with synthetic accounts. The routing test invokes `Harness.productTool`; it does not claim a real model selected the connector.
- Production outbound probes reached both official API paths and received the expected unauthenticated HTTP 401. No search credits were consumed.
- No official DeepSeek credential is configured on the production server. Authenticated search/fetch remain unverified until an official Key is added through the connector form.

Android and Mac already render connector catalogs, fields and balance snapshots supplied by the server. This addition changes cloud code and its Spec, with no installer or native UI changes.

Production deployment of `a623015495cdc880068d8758ae5218ccc04c92f0` completed after active work finished and a full private backup was taken. The live authenticated catalog returns the new connector and secret form, the official PNG icon returns HTTP 200, and the generated business prompt includes the new tools. The same main Session, all 250 chat message IDs, 60 memory files, 57 library files and 16 protected configuration files were preserved.
