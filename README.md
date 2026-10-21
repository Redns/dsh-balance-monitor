# dsh-balance-monitor · DSH 余额监控插件

在 DeepSeek Harness 侧边栏底部、**设置按钮的正上方**显示一行余额控件，盒子模型、字号、颜色与鼠标悬浮高亮都与设置按钮逐项一致，左侧是图标（默认**钱包**，共 19 个可选），中间是文本「余额」，右侧是「xxx￥」：

```
┌──────────────────────────────────┐
│ (钱包) 余额                12.69￥ ⟳ │   ← 本插件（设置按钮正上方）
├──────────────────────────────────┤
│ (齿轮) 设置                       │   ← DSH 原生设置按钮
└──────────────────────────────────┘
        ↑                              ↑
   图标左缘对齐                     文字左缘对齐
```

**点击整行**打开「额度消耗趋势」弹窗（剩余额度曲线 + 区间消耗，Tab 切换时间段）；行右侧的箭头是**手动刷新余额**。
侧边栏收窄成图标栏时，退化成与设置按钮同样的方形按钮 —— 这时**只显示「高峰 / 低谷」标签**（图标让位）：
36px 的图标栏按钮放不下 18px 图标 + 26px 标签，两者并排会把标签挤掉一半。关掉「显示时段标签」、
或宿主还没报出时段时，图标栏退回显示图标（图标一直在树里，只是被 `:has(.bm-phase)` 让位），不会变成空按钮。
点击仍然打开弹窗；**金额这时只出现在悬停气泡里**（`12.50￥（数据更新于 12:34:56）`，见下表）。

鼠标悬停在余额行上时，提示气泡用的是 **DSH 原生 Tooltip**
（`@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`）—— 和下方的「设置」按钮、侧边栏其它控件
**同一个组件、同一张样式表**，所以外观与出现时机完全一致：

| 项 | 值 | 来源 |
| --- | --- | --- |
| 背景 / 文字 | `--dsw-alias-tooltip-bg` / `--dsw-static-neutral-bluish-00` | 官方 `Tooltip.module.css` |
| 字号 / 行高 | 13px / 20px | 同左 |
| 内边距 / 圆角 | 3px 7px / `--dsw-radius-sm` | 同左 |
| 出现动画 | 150ms 淡入；`prefers-reduced-motion` 下不动画 | 同左 |
| 位置 | 默认在上方，空间不够自动翻到下方 | 官方定位逻辑 |

**气泡内容按展开态 / 收起态分开**（行本身显示什么，气泡就不重复什么）：

| 状态 | 气泡文案 | 理由 |
| --- | --- | --- |
| 展开（宽带侧边栏） | `查看额度消耗趋势（更新于 12:34:56）` | 金额就在行里，气泡只当动作提示 |
| 收起（图标栏） | `12.50￥（数据更新于 12:34:56）` | 36px 按钮里放不下金额，气泡是唯一能看到数字的地方 |

收起态的气泡跟 `currencySymbol` 设置走（`12.50￥` / `￥12.50` / 纯数字），还没读到值时为
`余额读取中… · 点击查看额度消耗趋势`，读到值但还没有刷新时间时为 `12.50￥（尚未更新）`。
无障碍名字（`aria-label`）在收起态仍然带上「点击查看额度消耗趋势」——气泡是状态，按钮的名字该说动作。

> 早先这里用的是浏览器原生 `title` 属性 —— 样式由浏览器决定、无法控制，延迟约 1 秒，和 DSH 风格不一致。
> 原生 `title` 已移除：留着它会**同时弹出两个提示**（原生气泡无法用 CSS 抑制）。行仍保留 `aria-label`。
> 行内刷新箭头的原生 tooltip 保持不变，它是独立控件。
>
> 这个 primitive 是客户端模块表里的**种子模块**（shell 的 `staticModules` 里有它），所以**不需要**
> 在 `package.json` 声明 `dsh.client.external`。

同时在 **设置 → 余额监控** 提供完整页面：实时余额、各币种明细、余额趋势曲线（十字光标悬停）、参数调节、诊断信息。

- **数据源**：DeepSeek 官方余额接口 `GET https://api.deepseek.com/user/balance`
- **API Key**：由宿主的 `credentials` 服务提供（即 `~/.dsh/.credentials.yaml` 里模型在用的那把 key），**不经过页面**
- **多币种**：返回账户内全部币种，徽章显示所选币种（默认自动 = 优先 CNY，否则第一个）
- **数字滚轮动画**：余额变化时每位**变化了的**数字上下滚动（上升滚绿、下降滚红，末段渐回原色）；余额没变时数字不动、**右侧刷新图标也不转**
- **峰谷时段提示**：余额右侧小标签显示当前是 `高峰` / `低谷` / `周末`，悬停看说明；侧边栏收起时这个小标签**独占**整个方形按钮（不再并排画图标）
- **额度消耗趋势弹窗**：点击余额行打开，剩余额度曲线 + 区间消耗 / 充入 / 平均消耗速率，Tab 切换时间段
- **图标可换**：19 个自带图标，设置页里看图形挑选
- **金额排版对齐官方**：数字与货币符号分开排版，符号更小更轻（见下）
- **无边框、跟随主题**：全部使用 DSH 主题变量（`--dsw-alias-*`），明暗主题自适应

本插件参考了 [yoiizesdev-crypto/DSH-Balance-display](https://github.com/yoiizesdev-crypto/DSH-Balance-display)（即 `dsh-quota-badge`）的宿主/浏览器双半结构与插槽接法，是独立实现。两者可以并存，也可以先卸载前者只用本插件。

## 安装

要求：DSH 0.2.0-rc.2 或兼容版本、Node.js ≥ 18、`pnpm` 在 PATH 上。

先**完全退出 DSH**（profile 被运行时独占，会有 `package.json.lock`），再执行下面的命令。

### 从 GitHub 安装（其它设备用这个）

把仓库推到 GitHub 之后，在每台设备的普通终端里：

```powershell
dsh plugin --profile web add github:<你的用户名>/<仓库名>
```

例如 `dsh plugin --profile web add github:yourname/dsh-balance-monitor`。

`dsh plugin add` 会**自动把包名写进 `dsh.profile.bundles`**，然后重启 DSH 即可。
如果想用 `pnpm` 直接装（等价，但不会自动改 `bundles`）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add github:<你的用户名>/<仓库名>
```

也可以锁定到某个提交或标签，便于复现：

```powershell
dsh plugin --profile web add "github:<用户名>/<仓库名>#v1.0.7"
dsh plugin --profile web add "github:<用户名>/<仓库名>#<commit-sha>"
```

> **本插件对 GitHub 安装特别友好**，因为它在 `package.json` 里：
> - **没有任何 `dependencies` / `peerDependencies`** —— DSH 对 git 安装是在**安装之后**才拿
>   已装好的清单去比对 peer 的，声明了无法满足的 peer 会走到 `incompatible-version`
>   分支，用户还得跑 `dsh plugin allow-version … --accept-risk` 才能装。本插件不声明 peer，
>   这一步直接跳过；
> - **没有任何 `prepare` / 构建脚本** —— pnpm 会拦截 git 包的构建脚本，要求用户手工把
>   pnpm 打印的 key 加进 profile 的 `pnpm-workspace.yaml` 里的 `allowBuilds`，否则安装失败。
>   本插件的 `lib/*.js` 就是最终产物，装完即可用；
> - **`files` 白名单只含 7 个文件**（`lib/`、`cordis.patch.yml`、三个文档 + `package.json`），
>   宿主入口、浏览器入口、bundle patch 都在里面。
>
> 这些约束由 `test/publishable.mjs` 守住 —— 它会检查有没有引入 peer 依赖、构建脚本，
> 以及 `files`/`exports` 是否漏掉加载器需要的文件。

### 从本地目录安装（开发这台机器用）

```powershell
# 用 dsh 自带插件管理器从本地目录安装（会 link 到仓库目录，改代码即时生效）
dsh plugin --profile web add "D:\Project\dsh-balance-monitor"

# 或直接用 pnpm（等价）
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add "D:\Project\dsh-balance-monitor"
```

> 本地路径安装会变成 `link:`，插件文件仍留在仓库目录里：好处是改 `lib/client.js` 热加载、
> 改 `lib/index.js` 重启即可；代价是这个目录不能删。想在别的设备上复现，用上面的 GitHub 方式。

### 目录拷贝（没有 pnpm / 没有网络时）

```powershell
$dest = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-balance-monitor"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "D:\Project\dsh-balance-monitor\lib","D:\Project\dsh-balance-monitor\cordis.patch.yml","D:\Project\dsh-balance-monitor\package.json" $dest -Recurse -Force
```

### 无论哪种方式，最后确认一下已启用

`dsh plugin add` 一般会自己加，但值得对一眼 —— 编辑
`%USERPROFILE%\.dsh\profiles\web\package.json`，`dsh.profile.bundles` 里应有包名：

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      // …已有的其它插件…
      "dsh-balance-monitor"        // ← 加上这一行
    ]
  }
}
```

然后**重新启动 DSH**（插件集合变更需要重启生效）。侧边栏底部、设置按钮上方就会出现余额控件；如果没出现，看 **设置 → 余额监控 → 诊断** 卡片。

> 核对是否已加载：
>
> ```powershell
> dsh plugin --profile web list      # 列出 profile 的插件
> ```
>
> 也可以直接问宿主（插件加载后会注册这个诊断路由）：
>
> ```powershell
> (Invoke-WebRequest http://127.0.0.1:3080/balance-monitor/health -UseBasicParsing).Content
> ```
>
> 返回的 `version` 就是**实际加载中**的版本。它和仓库里的 `lib/index.js` 的 `VERSION` 不一致，
> 说明宿主还是上次启动时读的旧代码 —— 宿主半边只在进程启动时读一次，改完必须重启。

## 更新到新版本

| 安装方式 | 更新方式 |
| --- | --- |
| `github:` | `dsh plugin --profile web add github:<用户名>/<仓库名>`（重跑一次，会拉到最新）；锁定过 `#tag` 的要显式换 tag |
| 本地路径 / `link:` | 不用更新，改的就是仓库目录里的文件；改完 `lib/index.js` 要重启 |
| 目录拷贝 | 重新拷一次 `lib/` 和 `package.json`，然后重启 |

更新后重启 DSH。参数设置在 `~/.dsh/.balance-monitor.json`；浏览器本地的 30 天采样在 `localStorage`，
两者都不受更新影响。

## 卸载

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm remove dsh-balance-monitor
# 并从 package.json 的 dsh.profile.bundles 里删掉 "dsh-balance-monitor"
```

目录拷贝安装的直接删掉 `node_modules\dsh-balance-monitor` 即可。插件的状态文件 `~/.dsh/.balance-monitor.json` 会保留，需要时自行删除。

### 卸载参考的旧插件（dsh-quota-badge）

本插件可以完全取代 [DSH-Balance-display](https://github.com/yoiizesdev-crypto/DSH-Balance-display)（npm 包名 `dsh-quota-badge`，侧边栏那行「余额 ● 12.69￥」）。**完全退出 DSH** 后：

```powershell
dsh plugin --profile web remove dsh-quota-badge
```

它自己的状态文件 `~/.dsh/.quota-badge.json` 和日志 `~/.dsh/.quota-badge.log` 不会自动删除，确认不需要后可以手工删掉。之后重启 DSH 即可。

## 额度消耗趋势弹窗（点击侧边栏余额行）

点击侧边栏的余额行打开弹窗；行右侧的箭头仍然是「立即刷新余额」。弹窗用外壳自带的 `Modal`
（遮罩、Esc / 点遮罩关闭、焦点陷阱与焦点归还都是原生行为），内容分三块：

| 区域 | 内容 |
| --- | --- |
| **时间段 Tab** | 近 1 小时 / 近 6 小时 / 近 24 小时 / 近 7 天 / 近 30 天 / 全部，默认「近 1 小时」；关掉弹窗再打开会保留上次选的时间段 |
| **剩余额度曲线** | 按采样点绘制余额曲线，悬停显示十字光标与「时刻 + 剩余额度」；下方给出区间最低 / 最高，以及**本区间采样点数与实际跨度** |
| **区间统计** | 区间消耗、区间充入、平均消耗速率（￥/小时）、剩余额度变化（起始 → 当前） |

Tab 里的「近 30 天」是真的 30 天：采样存在浏览器本地（见下文），不再受宿主 1440 条上限的限制。

### 消耗额是怎么算出来的

官方余额接口**不提供用量历史**，所以本插件只能从自己的采样里推算：

- 每次成功刷新余额都会记一条采样（`{ t, balances }`），曲线画的就是这些采样点的**剩余额度**。
- **消耗 = 相邻采样点之间余额的下降量之和**；余额的**上升**（充值 / 赠送额度到账）只计入「区间充入」。
  这样恒有 `区间消耗 - 区间充入 = 余额净变化`，不会出现「充值被当成消费」的错报——
  如果用「首尾相减」，一次充值就能把这半小时的消耗抹成 0 甚至负数。
- 区间开始之前的那次采样会作为**基线**参与计算（否则区间最前面那段消耗会被漏掉），
  但**不画进曲线**：它属于曲线首点所在的那个时间桶，画进去会把那个桶的数值拉偏。
  区间跨度也按基线算起，因为那段消耗确实发生在基线与首个采样点之间。
- 时间桶按**真实时间边界**归整（6 小时区间按整点、7 天 / 30 天区间按自然日），每个桶取桶内**最后**一个采样点，
  所以横轴读起来就是日历时间，而不是「从你打开弹窗那一刻算起的偏移」。短区间用 `HH:MM` 标注，超过 48 小时改用 `MM/DD`。
- 桶宽按**数据自身的跨度**选，并保证不超过图表宽度对应的点数（弹窗 512 点、设置页 Sparkline 180 点）：
  否则「近7天」在只有 18 小时数据时会按天分桶、只画出 2 个点，而一天 1440 条采样会变成 1440 个 SVG 节点。
- 弹窗底部与设置页趋势卡片都会显示**本区间采样点数与实际跨度**，避免把「有 25 万个采样点」和
  「画面上只有 31 个点」读混。

### 历史采样保存在浏览器本地（保留 30 天）

宿主那份历史有 **1440 条**上限（30 秒刷新一次约 12 小时），所以**页面自己**维护一条更长的序列，
存进浏览器的 `localStorage`：

| 项 | 值 |
| --- | --- |
| 键名 | `dsh-balance-monitor:history:v1`（按站点分库，与其它插件不冲突） |
| 保留时长 | **30 天**（超出即整段丢弃） |
| 条数上限 | 524288 条 |
| 每条大小 | **8 字节**：时间列是「相对本段第一条采样的 Uint32 毫秒偏移」，金额列是 **Float32** |
| 30 天 @10 秒 | 259200 条 ≈ **2.0MB**（base64 后 2.6M 字符），远低于浏览器每站点约 5MB 的配额 |
| 币种 | 一条序列只存**一个币种**（混存会让所有差额失真），切换币种会另起一条并提示 |

几条值得知道的行为：

- **宿主历史会被合并进来做种**：第一次打开时页面先读到余额、之后才拿到宿主历史的响应，
  这两步的顺序被显式处理，所以宿主已有的 1440 条不会丢；做种是合并而非覆盖，先记下的实时读数会保留。
- **写不进去也不会坏**：配额被同站点其它插件占满时，序列在内存里继续记录、砍掉较旧的一半后重试一次，
  并在诊断卡片里显示具体错误；`localStorage` 完全不可用时退化为仅内存（4000 条），页面照常工作。
- **按来源分库存放**：同一台机器的 Web 版（`http://127.0.0.1:3080`）与桌面版回环地址是**不同的 origin**，
  各自有一份独立的 30 天历史；换浏览器或清站点数据也会各自从头开始。
- 设置页「清空历史」会**同时清空宿主历史与浏览器本地采样**。
- 采样值以 **Float32** 保存：约 7 位有效数字，对千元级余额的误差约 4e-6 元，
  比一分钱小四个数量级；曲线尾部偶尔可见的亚分抖动就是这个精度造成的。

诊断卡片里有四行可以直接核对：本地采样存储、本地采样（条数 · 跨度 · 币种 · 保留 30 天）、
本地占用（大小 / 上限约 5MB）、本地写入错误，以及用于对照的「宿主历史 N 条（上限 1440）」。

## 设置 → 余额监控

| 卡片 | 内容 |
| --- | --- |
| **当前余额** | 所选币种大号数字 + 币种标签 + 状态圆点（绿=正常 / 红=错误）+ 手动刷新；下方列出账户内**每个币种**的余额，主币种高亮；账户级 `is_available` 为 false 时标注「账户不可用」；并显示**本机累计消费** |
| **余额趋势** | Sparkline 曲线 + 面积填充，支持近 1 小时 / 近 6 小时 / 近 24 小时 / 近 7 天 / 近 30 天 / 全部，鼠标悬停显示十字光标与「时间 + 金额」气泡，下方给出区间最低 / 最高 / 采样次数 |
| **参数** | 显示侧边栏余额、自动刷新、刷新间隔（5–3600 秒）、数字滚动时长（0.3–3 秒）、时段标签、货币符号位置、显示手动刷新按钮、显示币种、图标（19 个）、显示余额趋势，以及「清空历史」 |
| **诊断** | 传输方式、宿主版本、宿主 Node、请求计数、状态文件路径、宿主最近错误、页面传输错误 |

参数、浏览器本地的 30 天采样序列（`localStorage` 的 `dsh-balance-monitor:history:v1`）
和宿主的消费账本、最近的 1440 条采样（`~/.dsh/.balance-monitor.json`）分别保存。
宿主诊断日志写在 `~/.dsh/.balance-monitor.log`。

### 参数默认值

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `showBadge` | 开 | 关闭后设置按钮上方不再显示余额行 |
| `autoRefresh` | 开 | 关闭后不再定时查询（手动刷新仍可用） |
| `refreshInterval` | 30 | 秒，范围 5–3600 |
| `showRefreshButton` | 开 | 余额行右侧的刷新箭头 |
| `showTrend` | 开 | 「余额监控」页的趋势曲线 |
| `displayCurrency` | `auto` | `auto` = 优先 CNY，否则第一个可用币种；也可固定 `USD` 等 |
| `icon` | `wallet` | 见下方图标集合 |
| `rollDuration` | `0.85` | 数字滚动时长（秒），范围 0.3–3 |
| `rollStagger` | `0.04` | 相邻数位起步的间隔（秒），范围 0–0.2；`0` = 同时滚动 |
| `showPhaseTag` | 开 | 余额行显示「高峰 / 低谷 / 周末」时段标签 |
| `currencySymbol` | `after` | 货币符号位置：`after`（`12.69￥`）/ `before`（`￥12.69`）/ `none`（不显示） |

### 数字滚轮动画
余额变化时（自动刷新或手动刷新都算）：

- 只有**变化了的那几位数字**滚动：上升时从下往上滚、用状态绿；下降时从上往下滚、用状态红；动画末段 60% 起渐回主题原色。没变的位静止不闪。
- **各数位错开起步**：延迟按「右侧还有几位数字」算，所以**最低位先滚**、依次向左，读起来像机械里程表而不是整块数字一起滑。默认每位间隔 **0.04 秒**（`rollStagger`，设 0 就回到同时滚动）。
  - 延迟按**数字**计数而非字符：千分位逗号和小数点不占间隔，否则 `1,234.50`（6 位数字）的跨度会是 `1234.50`（6 位数字）的两倍。
  - 等待中的格子用 `animation-fill-mode: backwards` 保持起始状态，不会先闪一下最终值。
- 数字格子的宽度是 **`1.06ch`**（`1ch` = 当前字体 "0" 的字宽）。这一点很重要：早先写死 `.62em` 是按**系统字体**量的，换成 **Montserrat** 后数字约 0.65em 宽、超出格子，被 `overflow:hidden` 水平裁掉，**最右侧那位最明显**（右边没有相邻格子遮掩）。用 `ch` 后跟随实际加载的字体，换字体不会再复发。
- 变化前后的数字按**右对齐**逐位比较，所以 `9.99 → 10.02` 这种位数变化不会把每一位都判成"变了"。
- **余额没有变化时，右侧刷新图标不转**——滚动与旋转共用同一个"值是否变化"判定；刷新图标也只在有变化时才播放旋转动画。首次读数（没有可比基线）同样不转。
- 尊重 `prefers-reduced-motion`：该设置下不播放滚动动画。

### 峰谷时段提示
余额文字右侧有一个小标签，显示当前时段（这也是 DeepSeek 峰谷定价的提示）：

| 标签 | 颜色 | 含义 |
| --- | --- | --- |
| `高峰` | 橙 | 工作日（北京时间）9:00–12:00、14:00–18:00，价格约为低谷的 **2 倍** |
| `低谷` | 绿 | 工作日其余时段，约 **半价** |
| `周末` | 绿 | 周六/周日**全天**低谷价（2026-08-23 00:00 起生效） |

鼠标悬停标签会显示完整说明（含"约 2 倍 / 半价"和生效日期）。

**判定全部在宿主完成**，用固定 `+08:00` 偏移对 UTC 做算术：

- 不依赖运行机器的时区、locale、夏令时规则，也不依赖浏览器时钟；
- 窗口是**半开区间** `[from, to)`，所以 12:00 与 18:00 整点算低谷、11:59 与 17:59 算高峰；
- 相位在**每次读数时重算**（包括命中 5 秒查询缓存时），缓存不会返回过期的时段；
- 客户端每 30 秒重渲染一次，所以**即使自动刷新被关掉或查询失败**，标签也会按时段自己变化；
- 标签是固定 **26px 宽**的列，三个标签都是 2 个字，切换时不会把金额挤动；
- 标签与「余额」**垂直居中对齐**：`line-height:1` + `position:relative; top:1.5px`。
  这一行也是实测出来的 —— 行的 `align-items:center` 是按**行盒**（22px）居中标签的，
  而「余额」实际占的**字形墨迹盒**中心比行盒中心低约 1px、视觉字身中心更低，所以标签
  看起来"飘在上面"。`line-height:1` 让标签盒子紧贴自己的文字，`top` 再把它落到字形光学中心；
  只用 `top` 不动 margin/height，因此行的布局和 42px 高度不受影响。

边界与周末规则由 `test/pricing-phase.mjs` 用显式 UTC 瞬时值逐条覆盖（含 2026-08-23 前后
周末算高峰 / 算低谷的差异）。设置页可在「显示「高峰 / 低谷」时段标签」里关掉。

垂直对齐可以用 `tools/measure-tag-align.mjs <截图>` 复核：标签是浅色底、文字是深色，
普通"墨迹"扫描量不准它的盒子，所以这个脚本分别量出**标签背景盒**与**文字墨迹盒**的中线并给出差值。

### 金额排版与货币符号

余额行和设置页的大数字共用同一套排版：

| 项 | 值 | 说明 |
| --- | --- | --- |
| 字体 | `var(--dsw-font-family-brand)` | DSH 自带的官方品牌字体 **Montserrat** |
| 字重 | 500 | Montserrat 只提供 300/400/500；写 600 只会得到浏览器**合成伪粗体** |
| 数字宽度 | `tabular-nums` | 等宽数字，滚轮动画时不会左右抖动 |
| 数字与符号 | `align-items:baseline` | 基线对齐 |
| 符号大小/颜色 | 与数字**相同** | 不做缩小或改灰 |

Montserrat 由 DSH 主题自带（`montserrat-{light,regular,medium}.woff2`，SIL OFL），
本插件不打包字体文件，只引用主题变量，所以字体缺失时会自动回落到
`--dsw-font-family`（Segoe UI / 微软雅黑）—— 这正是官方品牌字体的用法。

#### 货币符号位置（可设置）

设置页 → 参数 → **货币符号**，三选一，余额行与设置页大数字同时生效：

| 选项 | 效果 |
| --- | --- |
| `12.69￥` | 符号在金额**之后**（默认） |
| `￥12.69` | 符号在金额**之前** |
| `不显示` | 只显示数字 |

非法值一律归一到默认（客户端 `symbolPosition()`，宿主 `SYMBOL_POSITIONS` 白名单 + 400）。
`test/host-smoke.mjs` 会交叉校验两份列表是否一致并逐个 POST 往返验证 —— 和图标白名单同样的坑，
列表不一致的症状就是「点了没反应」。

排版（字号、字宽、基线）可以用 `tools/measure-amount.mjs <截图>` 复核：它会给出每个字形的
升部高度与字宽推进量。

### 图标集合（19 个，可挑选）

设置页的「图标」卡片是一个图标选择器：每个图标一个方块，**看图形选**，点一下立即生效并保存。

全部图标都是插件自带的 16×16 手绘描边图形（`currentColor`、1.3px 描边、圆头圆角），与 DSH 原生 `IconSettingsOutline*` 同一网格、同一线宽，**不依赖任何图标包**：

| id | 名称 | id | 名称 | id | 名称 |
| --- | --- | --- | --- | --- | --- |
| `coin` | 金币 | `yuan` | 人民币 | `bank` | 银行 |
| `coins` | 金币堆 | `dollar` | 美元 | `safe` | 保险箱 |
| `bag` | 钱袋 | `euro` | 欧元 | `safe2` | 金库 |
| `sack` | 钱袋（F） | `pound` | 英镑 | `safe3` | 宝箱 |
| `wallet` | 钱包（默认） | `card` | 银行卡 | `chart` | 涨势图 |
| `purse` | 手拿包 | `tag` | 价签 | `gift` | 礼包 |
| `shopping` | 购物袋 | | | | |

预览（`npm run preview` 重新生成）：[design/icon-preview.svg](design/icon-preview.svg)、对照图 [design/alignment-preview.svg](design/alignment-preview.svg)。

#### 与「设置」按钮的对齐

原生设置按钮在展开态用 **16px** 图标、收窄成图标栏时才用 18px。余额行刻意取同样的数值：

| 属性 | 原生设置按钮 | 余额行 |
| --- | --- | --- |
| 高度 | 42px | 42px |
| 左内边距 | 8px | 8px |
| 水平外边距 | 外层的 `.triggerRow` 带 `margin: 4px -2px` | 行自带 `margin: 0 -2.5px` |
| 图标框 | 16px（展开）/ 18px（图标栏） | 16px（展开）/ 18px（图标栏） |
| 图标与文字间距 | 8px | 8px |
| 字号 | 14px | 14px |
| 悬浮背景 | `--dsw-alias-interactive-bg-hover` | 同左 |
| 图标栏内容 | 18px 齿轮 | 「高峰 / 低谷」标签居中（没有标签时才是 18px 图标） |

那行 **`margin: 0 -2.5px` 是唯一让图标和「余额」与「设置」对齐的东西**，不是随手写的负数。
原生 `settings.trigger` 按钮外面套着一层 `triggerRow`（`margin: 4px -2px`），所以齿轮和「设置」
的起点**比 footer 插槽自己的内容盒更靠左**；余额行必须同样往外拉才能对齐。

这个值是用**截图逐像素实测**收敛出来的（`tools/measure-rows.mjs`）。关键在于偏移量与渲染
缩放无关，所以不同缩放的截图可以直接比较：

| 拉出量 | 图标差 | 文字差 |
| --- | --- | --- |
| `-2px` | +3px | +4px |
| `-4px` | −5px | −4px |
| **`-2.5px`** | **0** | **0** |

拟合关系是 `行偏移 ≈ 4 × 拉出量 + 10`。剩余的 +1px 是钱包图形本身比齿轮宽 1px 造成的，
不是行偏移。**不要**把这行改成 0 或"整理"掉。

另外所有图形都控制在中心半径 ≈ 6.1 以内（原生齿轮约 6.08），避免出现"比齿轮大一圈"的观感；`test/icon-geometry.mjs` 会用真实路径解析器逐个校验边界与光学重量。

> **改图标集合时要改两处**：图形本身在 `lib/client.js` 的 `ICONS` 里，宿主 `lib/index.js` 的
> `ICON_IDS` 是它的校验白名单（宿主必须拒绝非法值，所以不能省）。两边不一致的症状是
> **点了图标没反应**——宿主回 400、旧值保留。`test/host-smoke.mjs` 会解析两份源码、断言
> 宿主接受每一个收集到的 id，并逐个 POST 往返验证；改漏了测试直接失败。

## 工作原理

| 端 | 文件 | 说明 |
| --- | --- | --- |
| Host | `lib/index.js` | Cordis 插件。注册 `GET /balance-monitor/health`（诊断）、`GET /balance-monitor/balance`（经 `credentials` 解析 `DEEPSEEK_API_KEY`，用全局 fetch 查询官方接口，返回全部币种）、`GET\|POST /balance-monitor/config`（读写参数 + 历史）、`POST /balance-monitor/reset`（清空历史） |
| 载体 | `lib/index.js` | `createCarrier(ctx)`：Web profile 用真实 `webServer` 注册路由（同源相对路径）；Electron 桌面版没有 `webServer`，则起一个只绑定 `127.0.0.1` 的回环 HTTP 服务（`17881–17890` 第一个空闲端口 + 每次启动随机令牌），并通过 `webserver/index-inject` 把 `window.__BALANCE_MONITOR_HOST__ = { origin, token, ports }` 注入渲染页面 |
| Client | `lib/client.js` | 浏览器插件 bundle（`window.__ModuleLoader__.load` 格式）：`sidebar.footer.action` 插槽注册余额行、`settings.section` 插槽注册「余额监控」页；`monitorFetch()` 统一处理宿主传输，模块级 store 用 `useSyncExternalStore` 同时驱动徽章与设置页 |
| 组合 | `cordis.patch.yml` | 声明 host 加载入口，loader 行只注入 `credentials`；`package.json` 的 `dsh.client` 声明浏览器半边（`platform: web`、`immediately: true`） |

**为什么宿主半边不注入 `webServer`**：桌面版组合永远不提供该服务，一行 `inject: [webServer]` 会永远停在 `pending (waiting for service: webServer)`——插件看起来加载了，实际什么都不注册。因此只有 `credentials` 是硬依赖，载体按存在与否自选。

**消费金额怎么来的**：官方接口没有用量历史，只给 `total_balance / granted_balance / topped_up_balance`。所以本插件把「相邻两次读数的**差额下降**」累加成消费，差额上升（充值）只更新基线、不计为负消费。这是**本机观测到的**消费，不是官方账单。

## 发布到 GitHub

仓库已经初始化好（分支 `main`，`ref-dsh-balance-display/` 已在 `.gitignore` 里排除）。
只需要加远端并推：

```powershell
cd D:\Project\dsh-balance-monitor
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```
发布的全部要求就是「推 `main`」：DSH 从 git 安装时读的是仓库根目录的 `package.json`，
所以升级版本 = 改 `package.json` 的 `version` + 写 `CHANGELOG.md` + 推送，**不需要打 tag**
（打 tag 只是给想锁版本的人用）。推之前跑一遍 `npm test` 即可 —— 其中
`test/publishable.mjs` 专门守跨设备安装的三个坑（peer 依赖、构建脚本、`files` 白名单）。

## 测试

```powershell
cd D:\Project\dsh-balance-monitor
npm test            # 宿主路由 + 桌面回环载体 + 客户端 bundle 冒烟测试（不需要网络）
npm run test:live   # 用真实的 credentials 与官方接口跑一遍数据链路
```

- `test/host-smoke.mjs`：用真实的 `node:http` 服务和 webServer 形状的假服务，覆盖全部路由、参数校验与钳制、持久化、effect 释放。**55 项检查。**
- `test/desktop-carrier.mjs`：在「没有 `webServer`」的桌面组合下驱动回环载体，并把注入行交给 DSH **自带的** `renderIndexInjections` 渲染、求值，再验证免鉴权 `/health`、缺令牌/错令牌 403、注入令牌 200、CORS 预检、释放后端口关闭。**26 项检查。**
- `test/client-smoke.mjs`：模拟 `window.__ModuleLoader__`、假 React、假 `localStorage` 和假 `locale`/`slots` 服务，驱动真实 `apply(ctx)` 并渲染每个组件（展开态、图标栏态、出错态、设置页、额度消耗趋势弹窗），直接驱动 `periodUsage` / `bucketPoints` / `historyWindowPoints` 等纯函数，并覆盖浏览器本地 30 天序列：编解码往返与损坏输入、30 天逐出、二分窗口切片、合并语义、做种闸门，以及**跨页面重新加载**的持久化与配额失败降级。**271 项检查。**
- `test/icon-geometry.mjs`：用一个真实的 SVG path 解析器（含相对指令、贝塞尔、弧线、H/V/S/T 简写）算出每个图标与每一条路径的**真实**包围盒，校验 19 个图标都在 16px 盒内、且光学半宽不超过原生齿轮（≈6.08），并断言行的几何契约（42px/8px/8px/16px）。**50 项检查。**
- `test/live-verify.mjs`：用 `@deepseek-ai/dsh-credentials-local` 自带的文档解析器读出 key（不打印），再驱动插件自己的路由打一次真实接口，校验 `granted + toppedUp = total` 等字段关系。
- `tools/verify-local-history.mjs`（不联网、只读本机状态）：把**真实的** `~/.dsh/.balance-monitor.json`
  当作假宿主的响应，用假 `localStorage` 求值一次 `lib/client.js`，再渲染侧边栏行、逐个切完弹窗的六个
  时间段 Tab、渲染设置页，并打印本地序列的条数 / 跨度 / 占用与各 Tab 的采样数。
  用来在浏览器之外复核「本地 30 天序列 + 做种 + 降采样」这条链路，不打印任何密钥。

## 已知限制与排查

| 症状 | 原因与处理 |
| --- | --- |
| 余额行不出现 | 插件集合变更未生效 → 重启 DSH；仍无 → 看设置页诊断卡片的「传输方式」 |
| 余额显示「读取失败」 | 宿主拿不到 key 或网络不通。诊断卡片会给出具体错误；确认 `~/.dsh/.credentials.yaml` 里有 `DEEPSEEK_API_KEY` |
| 桌面版（Electron）不显示 | 宿主半边会自动改用回环载体；若端口 `17881–17890` 全被占用会失败，日志在 `~/.dsh/.balance-monitor.log` |
| 与 `dsh-quota-badge` 同时显示两行 | 本插件 `order: -1` 排在它上方。想只留一个就卸载/禁用 `dsh-quota-badge`，或在设置页关掉本插件的余额行 |
| 趋势曲线空 | 历史是**装机后**才开始采样的（宿主从第一次成功刷新起记，浏览器本地 30 天序列同样如此），等几次刷新即可；「全部」区间会显示已有采样 |
| 弹窗里「近7天 / 近30天」只有最近十几个小时 | 浏览器本地序列是**这台机器、这个 origin** 建立起来的，换浏览器 / 清站点数据 / 桌面版回环地址都会另起一份。诊断卡片的「本地采样」会显示实际条数与跨度 |
| 弹窗提示「本地历史存的币种是 X」 | 一条本地序列只存一个币种（混存会让所有差额失真）。切回 X 就能看到这段历史，或在设置页「清空历史」后按当前币种重新开始 |
| 诊断卡片显示「本地占用 …仅内存」 | 页面拿不到 `localStorage`（例如无痕模式或站点数据被禁），此时只保留最近 4000 条且关掉页面即丢失；其余功能正常 |
| 曲线尾部有亚分抖动 | 采样值以 Float32 保存（约 7 位有效数字，千元级误差约 4e-6 元），是精度而非真实变化 |
| 点击余额行没有弹窗 | 先确认页面已刷新到新版客户端 bundle（宿主半边不需要重启，客户端改动页内热更新）；设置页「诊断」里可对照宿主版本 |
| 消费金额和官网对不上 | 这是按余额差额推的本机观测值，官网 30 天账单口径不同（见上文「消费金额怎么来的」） |

> 桌面版（Electron）的回环载体与注入行**已用 DSH 自带的 `renderIndexInjections` 验证通过**，但没有在真实的 Electron 窗口里跑过（本机是 Web profile）。Web profile 已完整验证。

## License

MIT
