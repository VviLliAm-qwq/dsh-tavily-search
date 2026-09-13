# dsh-web-tavily

[![ci](https://github.com/VviLliAm-qwq/dsh-web-tavily/actions/workflows/ci.yml/badge.svg)](https://github.com/VviLliAm-qwq/dsh-web-tavily/actions/workflows/ci.yml)

**中文** · [English](README.md)

为 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 构建。

dsh host 平面 cordis 插件：为 dsh 的 web 能力 seam（`ctx.web`）注册搜索提供商 **`tavily`**，让 `web_search` 工具默认走 **Tavily Search API**（`POST https://api.tavily.com/search`）。

- 不替换 `web_search` 工具本身：工具、系统提示、展示卡片均保持原样，只有搜索后端换成 Tavily。
- 保留 DeepSeek 原生搜索（`web-search-deepseek`）为可切换备选；想切回只需把 `web.searchProvider` 改为 `deepseek-official` 或删掉该键。
- key 一律按**引用**解析（默认 `TAVILY_API_KEY`）：优先凭证服务（`~/.dsh/.credentials.yaml` 的 `refs:`），其次启动环境变量，最后才是配置里的字面 `apiKey`。provider 不保留 key。

## 工作原理

1. 注册 provider（id = `tavily`）到 `ctx.web`；`web.searchProvider: tavily` 使其成为默认选择。
2. `web_search` 被调用时，seam 把 `{ query, maxResults }` 交给本 provider。
3. provider 解析 key（每次操作时快照，一次搜索不会混用两个配置版本）→ 请求 `{baseURL}/search`。
4. 响应映射：`results[] → sources[]`（`title` / `url` / `content→snippet`，若有 `published_date → publishedAt`），顶层 `answer`（Tavily 的 AI 总结）→ 工具的可选 `content` 摘要。
5. 取消（信号）→ `WEB_ABORTED`；HTTP 失败 / 不可解析 → `WEB_PROVIDER_ERROR`；缺 key → `WEB_PROVIDER_CREDENTIAL_MISSING`（错误信息带配置指引）。

## 默认配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `TAVILY_API_KEY` | 凭证引用（环境变量名） |
| `apiKey` | （无） | 字面 key，仅当不想走引用时使用 |
| `baseURL` | `https://api.tavily.com` | 可用环境变量 `TAVILY_BASE_URL` 覆盖 |
| `searchDepth` | `basic` | `basic` / `advanced`（advanced 更深度、额度消耗更高） |
| `topic` | `general` | `general` / `news` |
| `includeAnswer` | `true` | 是否请求 Tavily 的 AI 总结（映射为 `content`） |
| `maxResults` | `10` | 兜底结果数上限（`web_search` 每次实际传 8，Tavily 上限 20） |

## 安装

1. 装进 profile —— 它以 `dsh-web-tavily` 发布在 npm 上：

   ```sh
   dsh plugin --profile dsh-tui add dsh-web-tavily
   # 从本仓库本地安装（开发）：
   # dsh plugin --profile dsh-tui add file:<本包路径>
   ```

2. **把 web 服务默认搜索改为 tavily**（必须写在 profile 用户补丁层，`settings.yaml` 的 `web:` 段对服务配置无效）——
   编辑 `~/.dsh/profiles/dsh-tui/cordis.patch.yml` 追加：

   ```yaml
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: tavily
       fetchProvider: http-trusted
   ```

   `web` 行由基座 dsh-base 提供，**不要用 `insert:` 新增同 id 行**——那会撞 id 直接崩
   `duplicate loader entry id: web`；这里要按 id 覆盖既有行，且覆盖是**整行重写，需写全
   `fetchProvider`**。
3. 重启 dsh-tui（`/restart`）生效。

## 配置

插件自身的设置段放 `~/.dsh/settings.yaml`（设置页「Plugin configuration」里也会出现「Web search Tavily」类）：

```yaml
dsh-web-tavily:
  apiKeyEnv: TAVILY_API_KEY
  searchDepth: basic
  topic: general
  includeAnswer: true
  maxResults: 10
```

可用环境变量覆盖：`TAVILY_BASE_URL`（API 源），凭证引用键默认 `TAVILY_API_KEY`。

设置页把这个命名空间渲染成一张**中英双语卡片**（「联网搜索（Tavily）」/ Web search (Tavily)），每个字段都有说明；日常只需要改「凭证引用」那一项。密钥本身永远不进设置文档。

## key 存放（本机，不进代码库）

在 `~/.dsh/.credentials.yaml` 的 `refs:` 下添加（该文件属于本机凭证，不要提交/外发）：

```yaml
refs:
  TAVILY_API_KEY: 'tvly-...'
```

## 切回 DeepSeek 原生搜索

把 `web.searchProvider` 改为 `deepseek-official`（或删除该键、让 seam 用唯一可用 provider）。注意 seam 不支持自动回退：Tavily 配置失效时搜索会明确报错，而**不会**悄悄走 DeepSeek。

## 代理兼容 fetch（`http-trusted`）

本插件同时注册 `http-trusted` fetch provider，解决 **fake-IP 代理环境**（Clash 等把域名解析为 `198.18.0.0/15` 假地址）下 `web_fetch` 被官方 `http` provider 的安全预检拒绝的问题（`WEB_BLOCKED_URL: resolves to a non-public IP address`）。

- **复用官方 `@deepseek-ai/dsh-web-fetch-http` 传输层**：仅放宽「解析结果必须是公网 IP」这一预检——额外放行 `198.18.0.0/15`（代理 fake-IP 段），**其余全部照旧**：内网/环回/保留段照常拒绝（`WEB_BLOCKED_URL`）、IPv6 答案一律丢弃、地址 pinning、同源重定向、内容类型白名单、字节/字符上限、无凭证 cookie 等防护原封未动。
- ⚠️ **安全边界**：SSRF 防护从「宿主内强校验」退化为「信任本机代理的 DNS 决策」，网络的最终裁决权移交代理分流规则。**仅适用于单用户本机 + 自制可信代理**；多人共用/公网服务请回退官方 `http`（见下）。
- IP 来源特殊（`http://192.168.x.x/` 之类）仍会被拒绝。

```yaml
# ~/.dsh/profiles/dsh-tui/cordis.patch.yml 的 web 行
config:
  searchProvider: tavily
  fetchProvider: http-trusted
```

**回退官方 http**：把 `fetchProvider` 改回 `http`（代价：fake-IP 代理环境下 `web_fetch` 将再次被拒，但安全预检完整）。

## 加载失败排查

- 插件启动报 `duplicate loader entry id: web`：profile `cordis.patch.yml` 误用 `insert:` 新增同 id 行，按上文改写为直接行。
- `web_search` 报 `WEB_PROVIDER_CONFIGURED_MISSING`：插件未加载（检查 bundles 列表与上述补丁）。
- `web_fetch` 报 `WEB_BLOCKED_URL ... non-public IP`：代理假 IP 预检拒绝，改用 `http-trusted` 或关闭代理 fake-IP 模式。

## 限制说明

- Tavily key 缺失或失效 → `web_search` 报错（`WEB_PROVIDER_CREDENTIAL_MISSING` / `WEB_PROVIDER_ERROR`），按错误信息指引配置即可。
- `max_results` 会被钳制到 Tavily 上限 20。
- `searchDepth` / `topic` 非法值会直接报错，不会悄悄回退默认。

## 发布

- **仓库**：<https://github.com/VviLliAm-qwq/dsh-web-tavily>（公开）
- **发布方式**：`v*` tag 驱动 `.github/workflows/release.yml`，经 npm **可信发布（OIDC）**上传——仓库内不存放任何令牌。

## 使用

装好并配置 key 后，照常让模型调用 `web_search` 即可；工具返回的 `Sources:` 列表与可选总结即来自 Tavily。

## 许可

MIT — 见 [LICENSE](LICENSE)。
