import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/cabin.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/core/models/device.dart';
import 'package:octopus_mobile/core/models/task.dart';

void main() {
  group('Device', () {
    test('归一化地址：补协议、去尾斜杠', () {
      expect(normalizeBaseUrl('  https://a.ts.net/  '), 'https://a.ts.net');
      expect(
        normalizeBaseUrl('shufang-pc.tailxxxx.ts.net'),
        'https://shufang-pc.tailxxxx.ts.net',
      );
      expect(normalizeBaseUrl('10.0.2.2:3001'), 'http://10.0.2.2:3001');
      expect(
        normalizeBaseUrl('http://127.0.0.1:3001/'),
        'http://127.0.0.1:3001',
      );
    });

    test('从域名猜显示名', () {
      expect(
        guessDeviceName('https://shufang-pc.tailxxxx.ts.net'),
        'shufang-pc',
      );
    });

    test('fromJson 容忍缺名字', () {
      final d = Device.fromJson({'id': 'd1', 'baseUrl': 'https://mac.ts.net'});
      expect(d.name, 'mac');
      expect(d.baseUrl, 'https://mac.ts.net');
    });
  });

  group('CabinDetail', () {
    test('解析 cabin + view（attention / health）', () {
      final detail = CabinDetail.fromJson({
        'cabin': {
          'id': 'c1',
          'name': 'octopus-web',
          'path': r'C:\xzf\ai\open-octopus',
          'workspace_id': 'ws1',
          'main_session_id': 's1',
          'status': 'active',
        },
        'view': {
          'attention': [
            {'id': 'a1', 'stage': 'review', 'title': '待验收一条'},
            {
              'id': 'a2',
              'stage': 'answer',
              'title': '问一句',
              'question': '要不要删？',
            },
            {'id': 'a3', 'stage': 'start', 'title': '入列'},
          ],
          'health': {'running': 2, 'queued': 1},
          'open_findings': 3,
        },
      });
      expect(detail.cabin.name, 'octopus-web');
      expect(detail.cabin.workspaceId, 'ws1');
      expect(detail.reviewCount, 1);
      expect(detail.waitCount, 2);
      expect(detail.health.running, 2);
      expect(detail.openFindings, 3);
      expect(detail.attention[1].question, '要不要删？');
    });
  });

  group('ChatMessage', () {
    test('metadata 是 JSON 字符串时解析成 Map', () {
      final m = ChatMessage.fromJson({
        'id': 'm1',
        'sessionId': 's1',
        'role': 'assistant',
        'type': 'tool_call',
        'content': '',
        'createdAt': '2026-11-26T10:00:00Z',
        'metadata': '{"displayType":"tool_call","toolName":"Read","toolInput":{"file_path":"a.md"},"toolStatus":"done"}',
      });
      expect(m.displayType, 'tool_call');
      expect(m.toolName, 'Read');
      expect(m.toolStatus, 'done');
      expect(m.toolInputText, contains('file_path'));
    });

    test('坏 metadata 不抛异常', () {
      final m = ChatMessage.fromJson({
        'id': 'm2',
        'sessionId': 's1',
        'role': 'user',
        'type': 'text',
        'content': 'hi',
        'createdAt': '',
        'metadata': '{not json',
      });
      expect(m.meta, isNull);
      expect(m.content, 'hi');
    });

    test('thinking 行带内容与时长', () {
      final m = ChatMessage.fromJson({
        'id': 'm3',
        'sessionId': 's1',
        'role': 'assistant',
        'type': 'thinking',
        'content': '',
        'createdAt': '',
        'metadata': '{"displayType":"thinking","thinkingContent":"先核对","thinkingDuration":"3.2s"}',
      });
      expect(m.thinkingContent, '先核对');
      expect(m.thinkingDuration, '3.2s');
    });
  });

  group('ChatSession.fromAgentJson', () {
    test('ctx 用量 / 事件卡 / 折叠来源 / 中断标记都从 agent 行读出来', () {
      final session = ChatSession.fromAgentJson({
        'id': 's1',
        'workspace_id': 'w1',
        'created_at': '2026-11-27T10:00:00Z',
        'context_usage': {
          'totalTokens': 6200,
          'maxTokens': 100000,
          'rawMaxTokens': 100000,
          'percentage': 6.2,
          'estimated': false,
          'categories': [
            {
              'id': 'system_prompt',
              'name': 'System prompt',
              'tokens': 3100,
              'kind': 'used',
            },
            {
              'id': 'messages',
              'name': 'Messages',
              'tokens': 5600,
              'kind': 'used',
            },
            {
              'id': 'system_tools_deferred',
              'name': 'System tools (deferred)',
              'tokens': 24373,
              'kind': 'deferred',
              'isDeferred': true,
            },
          ],
        },
        'messages': {
          'items': [
            {
              'id': 'u1',
              'role': 'user',
              'content': '任务状态变更',
              'created_at': '2026-11-27T10:00:00Z',
              'metadata': '{"displayType":"event"}',
            },
            {
              'id': 'a1',
              'role': 'assistant',
              'content': '清完了。',
              'thinking': '先核对 manifest',
              'tool_calls': [
                {
                  'id': 't1',
                  'name': 'Edit',
                  'status': 'fail',
                  'input': {'file_path': 'spec/phase-1.md'},
                },
              ],
              'metadata': '{"timeline":[{"kind":"text","text":"清完了。"}],"interrupted":true}',
              'created_at': '2026-11-27T10:00:03Z',
            },
          ],
          'total': 2,
        },
      });

      expect(session.contextUsage!.percentage, 6.2);
      expect(session.contextUsage!.usedCategories.map((c) => c.id), [
        'system_prompt',
        'messages',
      ]);
      expect(session.contextUsage!.categories.last.isDeferred, isTrue);

      final user = session.messages.first;
      expect(user.isUser, isTrue);
      expect(user.isEvent, isTrue);

      final assistantRows = session.messages.skip(1).toList();
      expect(assistantRows.first.displayType, 'thinking');
      expect(assistantRows.first.sourceId, 'a1');
      expect(assistantRows[1].toolStatus, 'error');
      final text = assistantRows.last;
      expect(text.content, '清完了。');
      expect(text.interrupted, isTrue);
      expect(text.sourceId, 'a1');
    });
  });

  group('TaskItem', () {
    test('从 v4 task_spec 取 goal / phases / ac', () {
      final task = TaskItem.fromJson({
        'id': 't1',
        'name': '改版',
        'status': 'awaiting_review',
        'cabin_id': 'c1',
        'task_spec': {
          'format': 'v4',
          'goal': '把首页换掉',
          'ac': ['首屏可视', '移动端不塌'],
          'phases': [
            {'name': '规格', 'slug': 'spec', 'workflowRef': 'wf1'},
            {'name': '实现', 'slug': 'impl'},
          ],
        },
      });
      expect(task.goal, '把首页换掉');
      expect(task.phases, hasLength(2));
      expect(task.phases.first.workflowRef, 'wf1');
      expect(task.acceptance.length, 2);
      expect(taskStatusLabels[task.status], '待验收');
      expect(taskTone(task.status), TaskTone.review);
    });

    test('没有 task_spec 也不炸', () {
      final task = TaskItem.fromJson({
        'id': 't2',
        'name': 'x',
        'status': 'draft',
      });
      expect(task.goal, isNull);
      expect(task.phases, isEmpty);
    });
  });
}
