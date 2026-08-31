# web/ 架构守则(变更局部化)
1. **后端只经契约**:页面/组件只 import `backend`(src/backend/index.ts)与 `types.ts`,
   禁止直接 fetch/Tauri API。换后端 = 新增 backend/xxx.ts 一个文件。
2. **切片隔离**:features/<A>/ 禁止 import features/<B>/ 的任何文件;
   复用下沉到 components/ 或 backend 契约。改一个页面只动一个目录。
3. **视觉单点**:颜色/字体/圆角/阅读排版参数只写 theme/tokens.css(CSS 变量);
   组件内禁止硬编码色值。改视觉不触组件。
4. **行为单点**:一切可调参数(复习间隔/番茄钟/队列上限/任务预估时长)只写 config.ts;
   组件内禁止魔法数字。改规则不触页面。

## 目录导览

```
src/
├─ main.tsx              仅 bootstrap
├─ App.tsx               路由 + 侧栏外壳
├─ theme/tokens.css      全部设计代币(色/字/距/阅读排版参数)
├─ config.ts             全部行为参数(间隔天数/番茄钟/薄弱点上限…)
├─ types.ts              领域类型单源(镜像 core 模型,camelCase)
├─ store.ts              zustand:仅跨页会话状态(当前书/进行中任务)
├─ backend/
│  ├─ types.ts           Backend 接口(后端能力唯一契约)
│  ├─ mock.ts            MockBackend(内存种子数据+学生剧本)
│  └─ index.ts           运行时选择(Tauri 环境检测,现阶段恒 mock)
├─ components/           共享基础组件
└─ features/<页面>/      功能切片(today/library/map/reader/feynman/stats/settings)
```
