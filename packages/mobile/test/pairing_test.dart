import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/http.dart';
import 'package:octopus_mobile/core/pairing.dart';

import 'support/fake_api.dart';

Dio _dio(FakeHttpAdapter adapter, {String? token}) {
  final dio = Dio(BaseOptions(
    baseUrl: 'http://fake.local',
    validateStatus: (code) => code != null && code < 600,
    headers: {
      if (token != null) 'Authorization': 'Bearer $token',
    },
  ));
  dio.httpClientAdapter = adapter;
  return dio;
}

void main() {
  group('redeemPairCode', () {
    test('200：解析令牌 / 设备 id / 名字', () async {
      final dio = _dio(FakeHttpAdapter((options) {
        expect(options.path, '/api/pair/redeem');
        expect(options.data, {
          'code': '246810',
          'wants_remote': true,
          'name': '书房手机',
          'platform': 'android',
        });
        return jsonBody({
          'token': 'a' * 64,
          'device': {'id': 'dev-1', 'name': '书房手机'},
        });
      }));

      final result = await redeemPairCode(
        'http://fake.local',
        ' 246810 ',
        name: '书房手机',
        platform: 'android',
        dio: dio,
      );
      expect(result.token, 'a' * 64);
      expect(result.deviceId, 'dev-1');
      expect(result.name, '书房手机');
      expect(result.hasRemote, isFalse);
    });

    test('200 + ssh：带出私钥 / SSH 用户 / 端口 / 槽位', () async {
      const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n';
      final dio = _dio(FakeHttpAdapter((_) => jsonBody({
            'token': 'b' * 64,
            'device': {'id': 'dev-2', 'name': '书房手机', 'ssh_key_slot': 'slot-03'},
            'ssh': {
              'slot': 'slot-03',
              'user': 'EDY',
              'port': 22,
              'private_key': privateKey,
              'hosts': ['shufang-pc.tail1234.ts.net'],
            },
          })));

      final result = await redeemPairCode('http://fake.local', '246810', dio: dio);
      expect(result.hasRemote, isTrue);
      expect(result.sshKey, privateKey);
      expect(result.sshUser, 'EDY');
      expect(result.sshPort, 22);
      expect(result.sshSlot, 'slot-03');
    });

    test('200 + ssh_unavailable：配对照常成功，带一句人话', () async {
      final dio = _dio(FakeHttpAdapter((_) => jsonBody({
            'token': 'c' * 64,
            'device': {'id': 'dev-3', 'name': '手机'},
            'ssh_unavailable': 'not_installed',
          })));

      final result = await redeemPairCode('http://fake.local', '246810', dio: dio);
      expect(result.token, 'c' * 64);
      expect(result.hasRemote, isFalse);
      expect(result.remoteHint, contains('install-remote.ps1'));
    });

    test('400：把服务端那句「配对码不对」原样带出来', () async {
      final dio = _dio(FakeHttpAdapter(
        (_) => jsonBody({'error': 'pairing_failed', 'message': '配对码不对'}, status: 400),
      ));

      await expectLater(
        redeemPairCode('http://fake.local', '000000', dio: dio),
        throwsA(isA<ApiException>()
            .having((e) => e.message, 'message', '配对码不对')
            .having((e) => e.statusCode, 'status', 400)
            .having((e) => e.kind, 'kind', 'http')),
      );
    });

    test('200 但没有 token：报格式不对，不假装成功', () async {
      final dio = _dio(FakeHttpAdapter((_) => jsonBody({'device': {'id': 'x'}})));
      await expectLater(
        redeemPairCode('http://fake.local', '246810', dio: dio),
        throwsA(isA<ApiException>().having((e) => e.kind, 'kind', 'parse')),
      );
    });

    test('429：错误次数过多的提示照传', () async {
      final dio = _dio(FakeHttpAdapter(
        (_) => jsonBody(
          {'message': '配对码错误次数过多 —— 在电脑上重新生成一个'},
          status: 429,
        ),
      ));
      await expectLater(
        redeemPairCode('http://fake.local', '000000', dio: dio),
        throwsA(isA<ApiException>()
            .having((e) => e.statusCode, 'status', 429)
            .having((e) => e.message, 'message', contains('次数过多'))),
      );
    });
  });

  group('probeAuthorized', () {
    test('200 → true；401/403 → false；500 → true（交给页面报错）', () async {
      Future<bool> probe(int status) => probeAuthorized(
            'http://fake.local',
            dio: _dio(FakeHttpAdapter((_) => jsonBody({}, status: status))),
          );

      expect(await probe(200), isTrue);
      expect(await probe(401), isFalse);
      expect(await probe(403), isFalse);
      expect(await probe(500), isTrue);
    });
  });

  group('Authorization 注入', () {
    test('createApiDio 有令牌时每个请求都带 Bearer', () async {
      final seen = <String?>[];
      final dio = createApiDio('http://fake.local', token: 'tok-abc');
      dio.httpClientAdapter = FakeHttpAdapter((options) {
        seen.add(options.headers['Authorization'] as String?);
        return jsonBody({'cabins': []});
      });

      await dio.get<dynamic>('/api/cabins');
      await dio.get<dynamic>('/api/tasks');
      expect(seen, ['Bearer tok-abc', 'Bearer tok-abc']);
    });

    test('没有令牌时不带 Authorization（回环直连 / 还没配对）', () async {
      final seen = <String?>[];
      final dio = createApiDio('http://fake.local');
      dio.httpClientAdapter = FakeHttpAdapter((options) {
        seen.add(options.headers['Authorization'] as String?);
        return jsonBody({'cabins': []});
      });

      await dio.get<dynamic>('/api/cabins');
      expect(seen.single, isNull);
    });
  });
}
