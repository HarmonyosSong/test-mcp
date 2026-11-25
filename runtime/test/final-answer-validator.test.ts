import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVerdictMarker, validateFinalAnswer } from '../src/diagnosis/final-answer-validator.js';
import { ObservationRegistry } from '../src/diagnosis/observations.js';

function registryWithObservation(): { registry: ObservationRegistry; id: string } {
  const registry = new ObservationRegistry();
  const captured = registry.capture('read_project_file', { relative_path: 'src/a.ets' }, {
    path: 'src/a.ets',
    start_line: 1,
    content: 'throw new Error("boom")',
  }) as { evidence_refs: Array<{ id: string }> };
  return { registry, id: captured.evidence_refs[0]!.id };
}

test('合格回答通过并解析判定锚点', () => {
  const { registry, id } = registryWithObservation();
  const text = `判定：已定位\n崩溃由空指针引起，见 ${id} 的抛出点。`;
  const check = validateFinalAnswer(text, registry);
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.verdict, 'located');
  assert.equal(parseVerdictMarker(text), 'located');
  assert.equal(parseVerdictMarker('判定：证据不足\n还需要日志'), 'insufficient_evidence');
});

test('空回答被打回', () => {
  const check = validateFinalAnswer('   ', new ObservationRegistry());
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.feedback, /没有输出任何回答/);
});

test('DSML/工具协议文本泄露被打回；代码块内讨论协议豁免', () => {
  const { registry, id } = registryWithObservation();
  const leaked = `判定：已定位\n<｜｜DSML｜｜invoke name="read_project_file">… ${id}`;
  assert.equal(validateFinalAnswer(leaked, registry).ok, false);

  const discussing = '判定：证据不足\n```\n<｜｜DSML｜｜invoke name="x"> 是协议示例\n```\n需要更多日志。';
  assert.equal(validateFinalAnswer(discussing, registry).ok, true);
});

test('引用不存在的 ev-ID 被打回；真实 ID 通过', () => {
  const { registry, id } = registryWithObservation();
  const fabricated = `判定：可能定位\n见 ev-0000000000000000 的观测。`;
  const check = validateFinalAnswer(fabricated, registry);
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.feedback, /不存在的观测 ID/);

  const real = `判定：可能定位\n见 ${id} 的抛出点。`;
  assert.equal(validateFinalAnswer(real, registry).ok, true);
});

test('用户引用 ev-user-* 同样接受在册校验', () => {
  const registry = new ObservationRegistry({ inputTexts: ['提交作业失败，提示网络异常'] });
  const userRef = registry.registerUserTexts()[0]!.id;
  const ok = validateFinalAnswer(`判定：证据不足\n用户描述（${userRef}）缺少日志支撑。`, registry);
  assert.equal(ok.ok, true);
  const bad = validateFinalAnswer('判定：证据不足\n见 ev-user-000000000000。', registry);
  assert.equal(bad.ok, false);
});

test('缺少判定锚点被打回', () => {
  const { registry, id } = registryWithObservation();
  const check = validateFinalAnswer(`崩溃原因见 ${id}。`, registry);
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.feedback, /判定锚点/);
});

test('判定：信息查询 通过校验', () => {
  const registry = new ObservationRegistry();
  const text = `判定：信息查询

【学员信息】
学员编号：184010299547
UID：5570040

【最近登录设备（近7天）】
- iPad / 5.106.0 / device_id ABC`;
  const check = validateFinalAnswer(text, registry);
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.verdict, 'info_lookup');
  assert.equal(parseVerdictMarker(text), 'info_lookup');
});

test('信息查询未调日志工具却写未登录/暂无线索 → 打回', () => {
  const registry = new ObservationRegistry();
  const emptyLogin = `判定：信息查询

【学员信息】
UID：5570040

【最近登录设备（近7天）】
- 最近 7 天未登录`;
  const noTool = validateFinalAnswer(emptyLogin, registry, { calledTools: ['lookup_learner'] });
  assert.equal(noTool.ok, false);
  if (!noTool.ok) assert.match(noTool.feedback, /尚未调用 search_both_logs/);

  const vague = `判定：信息查询\n\n【最近登录设备（近7天）】\n暂无近 7 天登录设备线索。`;
  assert.equal(validateFinalAnswer(vague, registry).ok, false);

  // 只打日志中心 query、未打云日志 → 仍打回（客户端线索假阴性）
  const onlyLogcenter = validateFinalAnswer(emptyLogin, registry, { calledTools: ['query'] });
  assert.equal(onlyLogcenter.ok, false);

  const afterLog = validateFinalAnswer(emptyLogin, registry, {
    calledTools: ['lookup_learner', 'search_both_logs'],
    logQueries: ['5570040'],
  });
  assert.equal(afterLog.ok, true);

  // 用 card 当 query 后写未登录 → 打回
  const cardQuery = validateFinalAnswer(emptyLogin, registry, {
    calledTools: ['search_both_logs'],
    logQueries: ['184010299547'],
  });
  assert.equal(cardQuery.ok, false);
  if (!cardQuery.ok) assert.match(cardQuery.feedback, /学员编号/);

  const unavailable = `判定：信息查询\n\n【学员信息】\nUID：5570040\n\n【最近登录设备（近7天）】\n- 设备侧暂不可查`;
  assert.equal(validateFinalAnswer(unavailable, registry, { calledTools: ['lookup_learner'] }).ok, true);
});

test('声称已发起协查但本轮未调协查工具 → 打回；真调过 → 放行', () => {
  const registry = new ObservationRegistry();
  // 线上事故复刻（conv-c85c14a684）：把「发起协查」当叙述写进最终答复，实际从未调用。
  const claim = '判定：可能定位（初步）\n已把这批失败请求的原始对账凭据提交服务端协查，协查结果稍后会在本会话内同步。';
  const noCall = validateFinalAnswer(claim, registry, { calledTools: ['cloud_search'] });
  assert.equal(noCall.ok, false);
  if (!noCall.ok) assert.match(noCall.feedback, /并未调用 request_compass_followup/);

  // 「协查进行中」式表述同样拦截。
  const ongoing = '判定：可能定位（初步）\n服务端协查进行中，结果稍后同步。';
  assert.equal(validateFinalAnswer(ongoing, registry, { calledTools: ['cloud_search'] }).ok, false);

  // 真调过后台协查工具：放行（两种协查工具都算）。
  assert.equal(
    validateFinalAnswer(claim, registry, { calledTools: ['request_compass_followup'] }).ok,
    true,
  );
  assert.equal(
    validateFinalAnswer(ongoing, registry, { calledTools: ['consult_compass'] }).ok,
    true,
  );

  // 不误伤：说明「未协查」或建议「可再次发起协查」不是声称在途。
  const noClaim = '判定：可能定位\n本地证据缺口如上，未发起协查；如需服务端结论，可再次提问重新发起协查。';
  assert.equal(validateFinalAnswer(noClaim, registry, { calledTools: ['cloud_search'] }).ok, true);
});
