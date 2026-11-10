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
  const skill = registry.get('report-harmony-diagnosis');

  assert.ok(skill);
  assert.match(skill.instructions, /Every root-cause candidate, regardless of verdict, must cite at least one observed source or log/);
  assert.match(skill.instructions, /When returning `insufficient_evidence` because no source or log observation supports a cause, leave/);
  assert.match(skill.instructions, /do not turn them into incident candidates/);
  assert.match(skill.instructions, /set `likely_location` to null unless the current user-provided/);
  assert.match(skill.instructions, /Separate conditional code behavior from the observed incident/);
  assert.match(skill.instructions, /Do not write “the caller passed no name” as an incident fact/);
  assert.match(skill.instructions, /the verdict may be at most `probable`/);
});

test('location Skill preserves conflicting static rules as unresolved', async () => {
  const registry = new SkillRegistry(resolve(process.cwd(), '../skills'));
  await registry.load();
  const locate = registry.get('locate-harmony-issue');
  assert.ok(locate);
  assert.match(locate.instructions, /If relevant entries conflict, do not choose one as the current rule/);
  assert.match(locate.instructions, /Do not fill a location with a list of plausible components/);
});
