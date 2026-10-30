# 开发、验证与发布

## 仓库边界

| 路径 | 用途 |
|---|---|
| `src/` | 插件 Core、DSH 宿主集成与权限检查 |
| `client/client.js` | 侧栏前端 |
| `tests/` | 维护中的自动化测试 |
| `scripts/` | 构建、验证与打包脚本 |
| `docs/` | 预览版用户、开发和发布说明 |
| `dist/` | TypeScript 编译结果；**不提交 Git、必须包含在发布包** |
| `test/` | 测试运行输出、隔离 Profile 和测试包；不提交 Git |

长期产品设计、Agent 派工资料、原始宿主审计 ZIP 与内部证据仍留在开发工作区，不进入公开发行历史。

## 构建与验证

需要 Node.js 24+，pnpm 11.24.0，以及兼容 DSH 0.2.1-rc.2 的依赖。

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run pack:plugin
```

`pack:plugin` 先构建 `dist/`，再使用 `scripts/pack-plugin.mjs` 将源码、编译产物和运行元数据暂存打包，核对包内 `dist/index.js`、客户端文件等并输出 SHA-256。避免在根目录直接 `pnpm pack`：开发工作区的 `dist/` 可能是指向被忽略目录的 junction，直接打包会遗漏运行入口。

维护中的公开回归测试为 **585/585 PASS**。先前 5 项 C3a observer instrumentation 测试与现有宿主 RPC 调用结构不兼容；其历史源文件保存在本地开发分支，未纳入此次公开快照。它们没有被伪装成成功。

## 真实验证（2026-10-30）

| 检查 | 状态 |
|---|---|
| TypeScript 类型检查、公共回归测试 | PASS |
| 隔离 Windows DSH + Edge 挂载侧栏 | PASS |
| 创建/嵌套/折叠/移动/重命名文件夹 | PASS |
| 关闭重启 DSH 恢复目录 | PASS |
| 拒绝不存在的 Session ID | PASS |
| 真实 Session 关联、移动及点击打开 | **NOT RUN**：隔离环境无可读取的真实 Session |
| 独立 Reviewer、macOS/Linux、日常用户 Profile | **NOT RUN** |

模拟宿主单测不等于真实 Session 交互已验收；Lite 不等于原完整 v1.0。

## 发布

- 版本 `0.1.2-ui.1` 对应 Git tag `v0.1.2-ui.1`。
- GitHub 标签触发 [预览发布工作流](../.github/workflows/preview-release.yml)，生成 `.tgz` 并发布为 **GitHub prerelease**。
- npm registry 与 GitHub Releases 是两条不同渠道。只有在 npm 账户已认证并经 `pnpm publish --tag preview --access public` 实际成功后，才可以宣称 `workspace-organizer-dsh@preview` 可用；目前不能预设 npm 登录状态。
- 一个 `name@version` 不可重复覆盖。保留 SHA-256 和旧包供回滚核对。