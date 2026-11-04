# ShootLab · 投篮动作分析

***网站链接***: https://shootlab-pro.pages.dev/
浏览器里跑的投篮动作分析工具。上传一段投篮视频，它会逐帧识别人体姿态，
把一次出手拆成 8 项可量化的指标，和 NBA 球员基准对照，并给出可执行的改法。

**视频不上传。** 姿态识别用的是 MediaPipe Pose，模型随页面加载到本地运行，
整段视频不进任何服务器，断网也能分析。

---

## 能做什么

| 功能 | 说明 |
|---|---|
| 出手检测 | 从整段视频里自动找出每一次出手，一段 30 秒的连续投篮训练能挑出 9–10 次 |
| 八项指标 | 出手角、肘部对位、出手点高度、起跳弹速、出手节奏、躯干稳定、随球、下肢发力 |
| 时间轴联动 | 拖动进度条，右侧指标实时切换到「那一刻」的读数，并标明是第几次出手 |
| 标准姿势模板 | 按人体测量学比例现算一副火柴人，叠加在你身上做对照 |
| 手动修正出手点 | 抬手被误判成出手时，把视频停在真正出手的那一帧，一键重算全部指标 |
| 点位打法 | 篮下 / 近距 45° / 中距 45° / 罚球线 / 弧顶三分 / 底角，每个点的打板角度与瞄准点不同 |
| 进球概率 | 出手前给概率：球路物理反解 + 姿势评分，缺出手角时如实标低置信 |
| 自我校准 | 标记每次进没进，命中结果回流后用 Platt scaling 校正概率，样本越多越准 |
| 教练讲解 | 逐次出手分段圈画讲解，语音朗读 + 现场合成的背景和声 |

## 本地运行

页面用 ES module 加载姿态模型，**必须通过 http 打开**，双击 `index.html` 不行。

```bash
npm run serve          # 或：python tools/serve.py 8931 prototype
# 然后打开 http://127.0.0.1:8931/index.html
```

Windows 下也可以直接双击 `启动预览.bat`。

## 开发

`prototype/` 无构建步骤，改完 JS 刷新页面即可。仓库自带的质量检查：

```bash
ruff check tools               # Python lint（配置在 pyproject.toml）
node --check prototype/js/app.js  # 单个 JS 的语法检查
```

## 部署

`prototype/` 是一个纯静态站点，所有资源路径都是相对的，
整个目录放到任意子路径下都能跑，不依赖后端。

- **Cloudflare Pages（自动）**：仓库已带 `.github/workflows/deploy.yml`，
  推到 `main` 即部署到 Cloudflare Pages 两个项目
  （`shootlab-pro` 对外地址 + `shootlab` 旧地址）。
  需要 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
- **Cloudflare Pages（手动）**：`bash tools/deploy.sh`（需先 `wrangler login`）
- **其它静态托管**：把 `prototype/` 上传到站点子目录即可
- 注意服务端要能正确返回 `.wasm` 的 MIME 类型（`application/wasm`），
  否则姿态模型加载失败（`tools/serve.py` 本地已处理）

## 工具链环境

离线实验脚本（`tools/`）依赖 numpy、OpenCV、MediaPipe、Pillow、matplotlib，
依赖统一声明在根目录 `pyproject.toml`：

```bash
uv sync     # 没有 uv 就先 pip install uv；它按 pyproject.toml 建 .venv 并装依赖
# 不用 uv 的话手动装：pip install numpy opencv-python mediapipe pillow matplotlib
```

## 目录

```
prototype/            静态站点本体（部署的就是这个目录）
  index.html
  js/
    pose-engine.js    姿态识别、出手检测、球轨迹、全部指标计算
    metrics.js        指标定义与评分
    zone.js           点位打法、打板入射角、进球概率
    progress.js       命中结果回流与概率校准
    ghost.js          标准姿势火柴人模板
    coach.js          讲解层
    bgm.js            背景和声（Web Audio 现场合成，不含音频文件）
  models/             MediaPipe 姿态模型
  vendor/             ECharts、MediaPipe runtime
tools/                离线实验脚本（抽帧、姿态提取、球轨迹、批量建数据集）
  serve.py            带 Range 支持的本地静态服务器
data/                 离线实验产出的数据
.github/workflows/    ci.yml（lint/语法检查）、deploy.yml（推 main 自动部署）
```

## 指标是怎么来的

八项指标的理想区间不是拍脑袋定的，是拿 5 位 NBA 球员（库里、汤普森、杜兰特、
布克、利拉德）的投篮逐帧测出来再换算成「÷身高」的比值，区间下限放宽以容纳业余球友。

出手角用 Brancazio 的最优出手角公式 `θ = 45° + ½·atan((篮筐高 − 出手点高) / 水平距离)`，
再用抛物线反解出手速度与入筐角。打板入射角在**水平面**上算：
`atan2(|横向偏移|, 到篮板面距离)` —— 不是和竖直方向的夹角。

## 已知局限

- 人占画面高度低于 40% 时，厘米类指标（出手点、起跳）误差明显，界面会标红提示
- 球出手后很快飞出画面的机位，测不出出手角，此时概率预测只用姿势，置信度会标低
- 单目视频没有深度信息，球员前后走动会让人物尺度估计抖动，同一个人不同出手的
  出手点会有 ±20cm 的测量噪声
- 摄像头建议：横屏、全身入画、球出手后仍在画面里、机位不要跟着人晃

## 许可

[MIT](LICENSE)。MediaPipe 模型与 ECharts 的许可见其官方仓库。
