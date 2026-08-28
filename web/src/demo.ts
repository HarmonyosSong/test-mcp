import type { DiagnosticCase, MetaResponse } from './types';

export const demoMeta: MetaResponse = {
  mode: 'demo',
  model: null,
  skills: [
    {
      name: 'issue-intake',
      description: '将问题描述和原始证据整理为可排查的上下文。',
      version: '0.1.0',
      stage: 'intake',
    },
    {
      name: 'harmony-locator',
      description: '从工程结构、日志和调用链中收敛问题位置。',
      version: '0.1.0',
      stage: 'locate',
    },
    {
      name: 'evidence-investigator',
      description: '验证候选原因，记录支持与排除证据。',
      version: '0.1.0',
      stage: 'investigate',
    },
    {
      name: 'diagnosis-writer',
      description: '生成结构化诊断，不执行代码修复。',
      version: '0.1.0',
      stage: 'diagnose',
    },
  ],
  mcp_tools: ['workspace.read', 'workspace.search', 'logs.query'],
  constraints: ['read-only', 'no-shell', 'no-code-changes', 'no-deveco-cli'],
  context_windows: {},
  model_prices: {},
};

export const demoCases: DiagnosticCase[] = [
  {
    id: 'demo-navigation-blank',
    title: 'Navigation 返回后详情页出现空白',
    description:
      '平板双栏模式下从详情页返回列表，右侧内容区偶发空白；手机单栏模式未复现。',
    input_evidence:
      '复现设备：MatePad Pro，横屏。\n关键日志：NavPathStack pop completed, destination node not found。\n最近改动：将 pathStack 从页面状态迁移到 ViewModel。',
    workspace_path: '/workspace/entry/src/main/ets/pages',
    status: 'completed',
    created_at: '2026-08-26T01:18:00.000Z',
    updated_at: '2026-08-26T01:24:38.000Z',
    stages: [
      {
        key: 'intake',
        label: '接收问题',
        status: 'completed',
        summary: '确认异常仅发生在宽屏双栏返回路径，输入信息足以进入定位。',
        started_at: '2026-08-26T01:18:02.000Z',
        completed_at: '2026-08-26T01:18:19.000Z',
      },
      {
        key: 'locate',
        label: '定位范围',
        status: 'completed',
        summary:
          '问题收敛到详情路由栈的实例生命周期；空白时 Navigation 仍持有旧实例。',
        started_at: '2026-08-26T01:18:19.000Z',
        completed_at: '2026-08-26T01:20:41.000Z',
      },
      {
        key: 'investigate',
        label: '验证假设',
        status: 'completed',
        summary:
          '实例不一致与日志时间线吻合；详情数据请求均成功，排除网络与数据加载失败。',
        started_at: '2026-08-26T01:20:41.000Z',
        completed_at: '2026-08-26T01:23:50.000Z',
      },
      {
        key: 'diagnose',
        label: '生成诊断',
        status: 'completed',
        summary: '形成高置信度诊断并标注影响边界，未修改工程文件。',
        started_at: '2026-08-26T01:23:50.000Z',
        completed_at: '2026-08-26T01:24:38.000Z',
      },
    ],
    tool_events: [
      {
        id: 'tool-demo-01',
        tool: 'workspace.search',
        status: 'completed',
        summary: '检索 NavPathStack 的创建和使用位置，命中 4 处。',
        created_at: '2026-08-26T01:20:02.000Z',
      },
    ],
    report: {
      verdict: 'located',
      severity: 'high',
      summary:
        'Navigation 容器与返回动作使用了两个不同的 NavPathStack 实例，导致返回后内容区无法解析目标节点。',
      issue_category: 'ArkUI 页面或路由',
      confidence: 0.92,
      likely_location:
        'entry/src/main/ets/pages/WorkspacePage.ets 与 WorkspaceViewModel.ets 的 pathStack 初始化边界',
      root_cause_candidates: [
        {
          title: 'NavPathStack 实例在页面重建时被重复创建',
          explanation:
            '页面中的 Navigation 订阅旧实例，ViewModel 的 pop 操作落在新实例；对象标识和错误时间线一致。',
          confidence: 0.92,
          evidence_ids: ['ev-nav-log', 'ev-page-stack', 'ev-vm-stack'],
        },
        {
          title: '宽屏模式切换放大了生命周期差异',
          explanation:
            '双栏切换触发内容区重建，单栏没有相同重建路径，因此手机端不复现。',
          confidence: 0.76,
          evidence_ids: ['ev-layout-branch'],
        },
      ],
      evidence: [
        {
          id: 'ev-nav-log',
          kind: 'log',
          source: 'hilog / Navigation',
          location: '01:18:36.412',
          excerpt: 'pop completed; destination node not found',
          supports: '异常位于路由节点解析，而非详情数据请求。',
        },
        {
          id: 'ev-page-stack',
          kind: 'source',
          source: 'workspace.search',
          location: 'entry/src/main/ets/pages/WorkspacePage.ets:42',
          excerpt: 'Navigation(this.pathStack) { ... }',
          supports: '证明 Navigation 容器所绑定的状态源。',
        },
        {
          id: 'ev-vm-stack',
          kind: 'source',
          source: 'workspace.search',
          location: 'entry/src/main/ets/viewmodel/WorkspaceViewModel.ets:28',
          excerpt: 'private pathStack: NavPathStack = new NavPathStack()',
          supports: '证明 ViewModel 又创建了一份路由栈。',
        },
        {
          id: 'ev-layout-branch',
          kind: 'source',
          source: 'workspace.search',
          location: 'entry/src/main/ets/pages/WorkspacePage.ets:71',
          excerpt: 'mode(this.isWide ? NavigationMode.Split : NavigationMode.Stack)',
          supports: '说明宽屏切换会进入不同的重建路径。',
        },
      ],
      ruled_out: ['详情接口失败', '列表数据恢复失败', '用户输入导致的路由参数缺失'],
      missing_information: ['真实设备上一次完整的宽屏切换对象标识日志'],
      checks_performed: [
        '核对双栏与单栏的 Navigation 构建分支',
        '比对返回前后 NavPathStack 对象标识',
        '确认详情数据请求和状态恢复均成功',
      ],
      limitations: ['当前结论基于提供的日志与只读代码检索，未在真实设备执行交互复现。'],
    },
  },
  {
    id: 'demo-gridrow-breakpoint',
    title: 'GridRow 展开态没有切换为双栏',
    description:
      '折叠屏展开后窗口已变宽，但设置页仍保持手机单栏，旋转一次设备后布局才更新。',
    input_evidence:
      '初始宽度 388vp，展开后 782vp。页面 @StorageProp currentWidthBreakpoint 始终输出 WIDTH_SM。',
    workspace_path: '/workspace/entry/src/main/ets/pages/settings',
    status: 'running',
    created_at: '2026-08-26T02:03:12.000Z',
    updated_at: '2026-08-26T02:06:25.000Z',
    stages: [
      {
        key: 'intake',
        label: '接收问题',
        status: 'completed',
        summary: '确认是窗口变化后的响应式状态未同步，问题可稳定复现。',
        started_at: '2026-08-26T02:03:14.000Z',
        completed_at: '2026-08-26T02:03:31.000Z',
      },
      {
        key: 'locate',
        label: '定位范围',
        status: 'completed',
        summary:
          '定位到 EntryAbility 的窗口尺寸监听与 AppStorage 写入链；GridRow 声明含 md 分支。',
        started_at: '2026-08-26T02:03:31.000Z',
        completed_at: '2026-08-26T02:05:08.000Z',
      },
      {
        key: 'investigate',
        label: '验证假设',
        status: 'running',
        summary:
          '已发现 getMainWindowSync 在 loadContent 之前调用，正在确认监听是否注册到同一窗口实例。',
        started_at: '2026-08-26T02:05:08.000Z',
        completed_at: null,
      },
      {
        key: 'diagnose',
        label: '生成诊断',
        status: 'pending',
        summary: '等待排查证据闭环。',
        started_at: null,
        completed_at: null,
      },
    ],
    tool_events: [
      {
        id: 'tool-demo-02',
        tool: 'workspace.search',
        status: 'completed',
        summary: '已定位断点数据源和窗口监听注册位置。',
        created_at: '2026-08-26T02:05:54.000Z',
      },
    ],
  },
  {
    id: 'demo-startup-resource',
    title: '应用启动白屏并提示资源加载失败',
    description:
      'debug 包安装后启动停留白屏，release 包正常。希望定位是资源配置还是启动页面逻辑。',
    input_evidence:
      '错误码：17000002。日志片段：failed to resolve app.media.splash_mark from current resource manager。',
    workspace_path: '/workspace/entry/src/main/resources',
    status: 'queued',
    created_at: '2026-08-26T02:18:44.000Z',
    updated_at: '2026-08-26T02:18:44.000Z',
    stages: [
      {
        key: 'intake',
        label: '接收问题',
        status: 'pending',
        summary: '等待诊断执行器领取。',
        started_at: null,
        completed_at: null,
      },
      {
        key: 'locate',
        label: '定位范围',
        status: 'pending',
        summary: '',
        started_at: null,
        completed_at: null,
      },
      {
        key: 'investigate',
        label: '验证假设',
        status: 'pending',
        summary: '',
        started_at: null,
        completed_at: null,
      },
      {
        key: 'diagnose',
        label: '生成诊断',
        status: 'pending',
        summary: '',
        started_at: null,
        completed_at: null,
      },
    ],
    tool_events: [],
  },
];
