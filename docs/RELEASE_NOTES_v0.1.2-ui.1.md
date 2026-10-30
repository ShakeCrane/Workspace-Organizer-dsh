# Workspace Organizer Lite · v0.1.2-ui.1

**Preview / 预览版，非稳定版。**

这次首先交付更简洁的 DSH 侧栏文件夹体验，不等待 Memory / Instructions / 继承内核完成。

## 更新

- 多级文件夹创建、嵌套、展开、重命名和移动。
- Lite 侧边栏改为文件夹为主的布局，冗余行内按钮归入按需菜单。
- 支持已有 Session 的逻辑引用；未知或不可读的 Session ID 会被拒绝。
- 新的可复现 pnpm 打包流程：发布包必须包含 `dist/index.js`。

## 验证范围

585 项维护中测试全部通过；隔离 Windows DSH + Edge 验证了文件夹增删以外的创建、移动、重命名、重启恢复等正向流程和无效 Session 拒绝。

**尚未验证真实已存在的 Session 关联 → 移动 → 打开原会话的完整链路。** 独立 Reviewer、日常 Profile、其他操作系统未验证。

## 试用与回滚

从此预发行下载 `workspace-organizer-dsh-0.1.2-ui.1.tgz`：

```powershell
$env:DSH_HOME = 'C:\DSH-Lite-Isolated'
dsh --profile organizer-lite --from-default-profile web --dump-config
dsh plugin --profile organizer-lite add 'file:C:\path\workspace-organizer-dsh-0.1.2-ui.1.tgz'
dsh --profile organizer-lite
```

回滚：`dsh plugin --profile organizer-lite remove workspace-organizer-dsh`，可再装旧版。插件数据在 `DSH_HOME/workspace-organizer/`；删除前请备份。它不负责搬迁或删除原生聊天记录。

详情请看 [README](../README.md) 和 [开发验证](DEVELOPMENT.md)。此 GitHub prerelease 不意味着 npm registry 已发布。