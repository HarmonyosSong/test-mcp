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
