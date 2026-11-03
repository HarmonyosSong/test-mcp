import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSkill } from '../src/diagnosis/skills.js';

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
  assert.equal(skill.instructions, 'Use the source instructions.');
  assert.deepEqual(skill.modes, ['chat']);
  assert.deepEqual(skill.requiredTools, ['lookup_issue']);
});
