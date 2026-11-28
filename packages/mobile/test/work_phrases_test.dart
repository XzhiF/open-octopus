import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/work_phrases.dart';

void main() {
  test('每个阶段 18 句，和桌面文案表同量级', () {
    for (final phase in WorkPhase.values) {
      expect(kWorkPhrases[phase], hasLength(18), reason: '$phase');
    }
    expect(kWorkSpin, hasLength(10));
  });

  test('每 6 秒换一句；同一轮内顺序稳定', () {
    final a = workPhrase(WorkPhase.exec, 0, seed: 1234);
    final b = workPhrase(WorkPhase.exec, 5, seed: 1234);
    final c = workPhrase(WorkPhase.exec, 6, seed: 1234);
    expect(b, a);
    expect(c, isNot(a));
    expect(kWorkPhrases[WorkPhase.exec], contains(c));
  });

  test('不传 seed 时按原数组顺序轮换', () {
    expect(
      workPhrase(WorkPhase.thinking, 0),
      kWorkPhrases[WorkPhase.thinking]![0],
    );
    expect(
      workPhrase(WorkPhase.thinking, 6),
      kWorkPhrases[WorkPhase.thinking]![1],
    );
  });

  test('seed 决定开头：不同 seed 洗出不同顺序，同 seed 可复现', () {
    final first = orderedWorkPhrases(WorkPhase.writing, 42);
    final again = orderedWorkPhrases(WorkPhase.writing, 42);
    final other = orderedWorkPhrases(WorkPhase.writing, 99);
    expect(first, again);
    expect(first, isNot(other));
    expect(first.toSet(), kWorkPhrases[WorkPhase.writing]!.toSet());
  });

  test('转字 100ms 一帧；计时 0:12 / 1:02:03', () {
    expect(workSpinGlyph(0), kWorkSpin[0]);
    expect(workSpinGlyph(.35), kWorkSpin[3]);
    expect(workSpinGlyph(1.0), kWorkSpin[0]);

    expect(formatWorkElapsed(12), '0:12');
    expect(formatWorkElapsed(72), '1:12');
    expect(formatWorkElapsed(3723), '1:02:03');
  });
}
