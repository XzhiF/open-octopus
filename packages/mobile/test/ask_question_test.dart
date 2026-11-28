import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/ask_question.dart';

void main() {
  group('parseAskQuestions', () {
    test('从 metadata.questions 读出单选 / 多选与选项', () {
      final questions = parseAskQuestions([
        {
          'header': '删除范围',
          'question': 'phase 2 删掉后，引用怎么处理？',
          'multiSelect': false,
          'options': [
            {'label': '一起清掉', 'description': 'spec + 验收清单全删'},
            {'label': '只删 spec', 'description': '验收清单下一轮再收'},
          ],
        },
        {
          'header': '留档',
          'question': '这批产物要留哪些档？',
          'multiSelect': true,
          'options': [
            {'label': 'diff 摘要'},
            {'label': '证据截图'},
          ],
        },
      ]);

      expect(questions, hasLength(2));
      expect(questions[0].header, '删除范围');
      expect(questions[0].multiSelect, isFalse);
      expect(questions[0].options[0].label, '一起清掉');
      expect(questions[1].multiSelect, isTrue);
      expect(questions[1].options, hasLength(2));
    });

    test('工具入参形状与 JSON 字符串都能读；坏数据不抛', () {
      final fromToolInput = parseAskQuestions({
        'questions': [
          {'question': '用哪个渠道？', 'header': '渠道'},
        ],
      });
      expect(fromToolInput.single.question, '用哪个渠道？');

      final fromString = parseAskQuestions(
        '{"questions":[{"question":"确认吗？","options":[{"label":"确认"}]}]}',
      );
      expect(fromString.single.options.single.label, '确认');

      expect(parseAskQuestions('not json'), isEmpty);
      expect(parseAskQuestions(null), isEmpty);
    });
  });

  group('回答正文', () {
    final questions = [
      const AskQuestion(
        question: '引用怎么处理？',
        header: '删除范围',
        options: [
          AskOption(label: '一起清掉'),
          AskOption(label: '其他'),
        ],
      ),
      const AskQuestion(
        question: '要留哪些档？',
        header: '留档',
        multiSelect: true,
        options: [
          AskOption(label: 'diff 摘要'),
          AskOption(label: '证据截图'),
        ],
      ),
    ];

    test('单选 + 多选按桌面同一格式拼正文', () {
      final text = formatAskAnswer(questions, {
        0: {'一起清掉'},
        1: {'diff 摘要', '证据截图'},
      }, const {});
      expect(text, contains('用户回答了以下问题：'));
      expect(text, contains('1. [删除范围] 引用怎么处理？'));
      expect(text, contains('   → 一起清掉'));
      expect(text, contains('2. [留档] 要留哪些档？'));
      expect(text, contains('   → diff 摘要, 证据截图'));
    });

    test('「其他」用输入的文本作答；空文本不算答', () {
      final empty = formatAskAnswer(
        questions,
        {
          0: {'其他'},
          1: {'diff 摘要'},
        },
        const {0: '   '},
      );
      expect(empty, isNot(contains('引用怎么处理？')));

      final filled = formatAskAnswer(
        questions,
        {
          0: {'其他'},
          1: {'diff 摘要'},
        },
        const {0: '先只清三处'},
      );
      expect(filled, contains('→ 先只清三处'));
    });

    test('「先讨论」把问题与当前填写交回 agent', () {
      final text = formatAskChatAbout(
        questions,
        {
          0: {'一起清掉'},
        },
        const {0: '清单也要看'},
      );
      expect(text, startsWith('用户想先讨论这些问题'));
      expect(text, contains('- “引用怎么处理？”'));
      expect(text, contains('当前答案：一起清掉'));
      expect(text, contains('用户补充：清单也要看'));
    });
  });

  group('askAnswerSummary', () {
    test('结构化回答压成一行值', () {
      expect(
        askAnswerSummary(
          '用户回答了以下问题：\n\n'
          '1. [删除范围] 引用怎么处理？\n'
          '   → 一起清掉\n\n'
          '2. [留档] 要留哪些档？\n'
          '   → diff 摘要, 证据截图',
        ),
        '一起清掉；diff 摘要, 证据截图',
      );
    });

    test('先讨论 / 普通消息分开', () {
      expect(askAnswerSummary('用户想先讨论这些问题，而不是直接作答。'), '先讨论');
      expect(askAnswerSummary('好，一起清掉'), isNull);
    });
  });
}
