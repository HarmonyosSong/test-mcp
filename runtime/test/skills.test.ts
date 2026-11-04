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

test('dev knowledge Skill is available only when both external tools are mounted', async () => {
  const registry = new SkillRegistry(resolve(process.cwd(), '../skills'));
  await registry.load();

  assert.equal(
    registry.available('chat', new Set(['resolve_external_knowledge', 'load_skill']))
      .some((skill) => skill.name === 'use-dev-knowledge-mcp'),
    false,
  );
  assert.equal(
    registry.available('chat', new Set(['resolve_external_knowledge', 'read_external_knowledge', 'load_skill']))
      .some((skill) => skill.name === 'use-dev-knowledge-mcp'),
    true,
  );
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

test('location and external knowledge Skills preserve conflicting static rules as unresolved', async () => {
  const registry = new SkillRegistry(resolve(process.cwd(), '../skills'));
  await registry.load();
  const locate = registry.get('locate-harmony-issue');
  const externalKnowledge = registry.get('use-dev-knowledge-mcp');

  assert.ok(locate);
  assert.ok(externalKnowledge);
  assert.match(locate.instructions, /If relevant entries conflict, do not choose one as the current rule/);
  assert.match(locate.instructions, /Do not fill a location with a list of plausible components/);
  assert.match(externalKnowledge.instructions, /When local entries disagree about a rule, preserve the disagreement/);
});
