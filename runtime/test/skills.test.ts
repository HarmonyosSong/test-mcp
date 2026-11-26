import assert from 'node:assert/strict';
import test from 'node:test';

import { resolve } from 'node:path';

import { parseSkill, SkillRegistry } from '../src/diagnosis/skills.js';

test('skill loader keeps markdown authoritative and filters required tools', () => {
  const skill = parseSkill(`---
name: example
description: example skill
metadata:
  version: "0.2.0"
  stage: investigate
  modes: [chat]
  required_tools: [lookup_issue]
---

Use the source instructions.
`, '/tmp/SKILL.md');
  assert.equal(skill.name, 'example');
  assert.equal(skill.version, '0.2.0');
  assert.equal(skill.stage, 'investigate');
  assert.equal(skill.instructions, 'Use the source instructions.');
  assert.deepEqual(skill.modes, ['chat']);
  assert.deepEqual(skill.requiredTools, ['lookup_issue']);
});

test('diagnosis report Skill keeps knowledge leads out of unsupported root-cause candidates', async () => {
  const registry = new SkillRegistry(resolve(process.cwd(), '../skills'));
  await registry.load();
  const skill = registry.get('report-app-diagnosis');

  assert.ok(skill);
  // 自由文本契约：判定锚点首行强制、ev-ID 引用纪律、条件行为与已观察事故区分。
  assert.match(skill.instructions, /判定：已定位/);
  assert.match(skill.instructions, /禁止自创/);
  assert.match(skill.instructions, /知识线索/);
  assert.match(skill.instructions, /区分条件行为与已观察事故/);
  assert.match(skill.instructions, /判定至多为 `可能定位`/);
});

test('location Skill preserves conflicting static rules as unresolved', async () => {
  const registry = new SkillRegistry(resolve(process.cwd(), '../skills'));
  await registry.load();
  const locate = registry.get('locate-app-issue');
  assert.ok(locate);
  assert.match(locate.instructions, /If relevant entries conflict, do not choose one as the current rule/);
  assert.match(locate.instructions, /Do not fill a location with a list of plausible components/);
});

test('lookup-learner-profile Skill 闭环：编号/uid 分流与信息查询模板', async () => {
  const registry = new SkillRegistry(resolve(process.cwd(), '../skills'));
  await registry.load();
  const skill = registry.get('lookup-learner-profile');
  assert.ok(skill);
  assert.equal(skill.stage, 'intake');
  assert.match(skill.description, /学员/);
  assert.match(skill.instructions, /lookup_learner/);
  assert.match(skill.instructions, /≥11/);
  assert.match(skill.instructions, /uid 裸数字/);
  assert.match(skill.instructions, /禁止学员编号/);
  assert.match(skill.instructions, /cloud=\{\}/);
  assert.match(skill.instructions, /最近 3 天未登录/);
  assert.match(skill.instructions, /time="3d"/);
  assert.match(skill.instructions, /未调 log-mcp 前禁止/);
  // 锚点必须在信息查询模板代码块里（模型照抄模板时不会被校验打回），而非只出现在散文里。
  assert.match(skill.instructions, /```text\n判定：信息查询/);
  assert.match(skill.instructions, /请补充学员编号或 uid/);
  assert.match(skill.instructions, /log-mcp/);
  // 不锁定 required_tools：ucenter 未配置时 uid 直连路径仍应能加载本技能。
  assert.deepEqual(skill.requiredTools, []);
});
