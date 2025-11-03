---
title: "ArkTS简介"
source: https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/introduction-to-arkts
converted: 2025-11-03 14:00:00
components: [ArkTS, 声明式UI, 状态管理, TypeScript]
methods: [@Component, @Entry, @State, build()]
type: HarmonyOS Documentation
---

# ArkTS简介

> 原文链接: [https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/introduction-to-arkts](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/introduction-to-arkts)
> 转换时间: 2025-11-03 14:00:00

## 📋 组件/接口
- ArkTS语言基础
- 声明式UI开发范式
- 状态管理机制
- TypeScript扩展特性

## 🔧 核心装饰器
- `@Component` - 组件装饰器
- `@Entry` - 入口组件装饰器  
- `@State` - 状态管理装饰器
- `@Prop` - 属性装饰器
- `@Link` - 双向绑定装饰器

---

## 什么是ArkTS

**ArkTS**是鸿蒙生态的应用开发语言。它在**TypeScript**（简称TS）生态基础上做了进一步扩展，继承了TS的所有特性，是TS的超集。

### 核心特性

#### 1. 声明式UI开发范式
ArkTS提供了声明式UI开发范式，具有简洁、自然的UI信息语法、丰富的UI组件、以及实时界面预览等特点，帮助您提升应用开发效率，并能实现生动而流畅的用户体验。

```typescript
@Entry
@Component
struct HelloWorld {
  @State message: string = 'Hello World';

  build() {
    Row() {
      Column() {
        Text(this.message)
          .fontSize(50)
          .fontWeight(FontWeight.Bold)
      }
      .width('100%')
    }
    .height('100%')
  }
}
```

#### 2. 状态管理机制
ArkTS提供了多维度的状态管理机制。在UI开发框架中，UI是程序状态的运行结果，用户的交互是程序状态改变的驱动力。

**状态管理装饰器：**
- `@State`: 组件内状态
- `@Prop`: 父子单向传递
- `@Link`: 父子双向绑定
- `@Observed` & `@ObjectLink`: 观察对象变化
- `@Provide` & `@Consume`: 跨组件传递

```typescript
@Component
struct Counter {
  @State count: number = 0;

  build() {
    Column() {
      Text(`计数: ${this.count}`)
        .fontSize(30)
      
      Button('增加')
        .onClick(() => {
          this.count++;
        })
    }
  }
}
```

#### 3. 渲染控制语法
ArkTS提供了条件渲染、循环渲染等渲染控制的能力，辅以组件内的状态变量、组件间的状态共享，开发者可以灵活地控制UI程序中的数据读写。

**条件渲染：**
```typescript
@Component
struct ConditionalRender {
  @State isVisible: boolean = true;

  build() {
    Column() {
      if (this.isVisible) {
        Text('可见内容')
      } else {
        Text('隐藏时显示的内容')
      }
    }
  }
}
```

**循环渲染：**
```typescript
@Component
struct ListDemo {
  @State arr: number[] = [1, 2, 3, 4, 5];

  build() {
    Column() {
      ForEach(this.arr, (item: number) => {
        Text(`Item ${item}`)
          .fontSize(20)
      }, (item: number) => item.toString())
    }
  }
}
```

#### 4. 并发能力增强
ArkTS在系统能力调用等方面做了优化，例如提供了TaskPool、Worker等并发能力，以及异步并发和多线程并发等机制，能够提升应用性能。

**TaskPool示例：**
```typescript
import taskpool from '@ohos.taskpool';

// 定义并发函数
@Concurrent
function add(a: number, b: number): number {
  return a + b;
}

// 使用TaskPool
async function useTaskPool() {
  try {
    let task = new taskpool.Task(add, 1, 2);
    let result = await taskpool.execute(task);
    console.log('计算结果:', result);
  } catch (e) {
    console.error('TaskPool执行失败:', e);
  }
}
```

## ArkTS的优势

### 1. 基于TypeScript
- 继承TypeScript的类型安全特性
- 支持现代JavaScript特性
- 丰富的开发工具支持

### 2. 声明式开发
- 简洁直观的UI描述语法
- 数据驱动的UI更新机制
- 组件化开发模式

### 3. 高性能渲染
- 编译时优化
- 增量更新机制
- 高效的状态管理

### 4. 生态兼容
- 支持NPM包导入
- TypeScript生态复用
- 渐进式学习路径

## 开发环境

### DevEco Studio
推荐使用华为官方IDE **DevEco Studio** 进行ArkTS应用开发：

1. **代码智能提示**：提供ArkTS语法高亮、代码补全
2. **可视化设计**：拖拽式UI设计器
3. **实时预览**：代码修改实时预览效果
4. **调试工具**：完善的调试和性能分析工具

### 项目结构
```
MyApplication/
├── entry/                    # 主模块
│   └── src/main/ets/        # ArkTS源码目录
│       ├── entryability/    # 应用入口
│       ├── pages/           # 页面文件
│       └── common/          # 公共资源
├── build-profile.json5      # 构建配置
└── hvigor/                  # 构建工具
```

## 学习路径

### 1. 基础阶段
- TypeScript基础语法
- ArkTS装饰器概念
- 基础UI组件使用

### 2. 进阶阶段
- 状态管理机制
- 自定义组件开发
- 页面路由和导航

### 3. 高级阶段
- 性能优化技巧
- 并发编程模式
- 跨平台特性应用

## 总结

ArkTS作为鸿蒙生态的核心开发语言，通过声明式UI、强大的状态管理和现代化的开发体验，为开发者提供了高效的应用开发能力。它不仅保持了TypeScript的优秀特性，还针对鸿蒙系统做了专门的优化和扩展。

通过学习和掌握ArkTS，开发者可以：
- 快速构建现代化的鸿蒙应用
- 享受类型安全的开发体验  
- 利用丰富的系统能力
- 实现跨设备的一致体验

---

*更多详细信息请参考：[ArkTS官方文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/introduction-to-arkts)*

