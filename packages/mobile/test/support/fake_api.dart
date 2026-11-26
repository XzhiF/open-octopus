import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:octopus_mobile/core/api.dart';

/// 假的 HTTP 适配器：让 api 层（dio 解析 + SSE 分帧）跑在固定字节流上。
/// 不需要模拟器 / 不需要真服务，也能验证「服务端返回长什么样 → App 收到什么」。
class FakeHttpAdapter implements HttpClientAdapter {
  FakeHttpAdapter(this.handler);

  final FutureOr<ResponseBody> Function(RequestOptions options) handler;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      handler(options);

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonBody(Object data) => ResponseBody.fromString(
      jsonEncode(data),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

ResponseBody sseBody(List<String> chunks) => ResponseBody(
      Stream.fromIterable(chunks.map((c) => Uint8List.fromList(utf8.encode(c)))),
      200,
      headers: {
        Headers.contentTypeHeader: ['text/event-stream'],
      },
    );

OctopusApi apiFor(HttpClientAdapter adapter) {
  final dio = Dio(BaseOptions(
    baseUrl: 'http://fake.local',
    validateStatus: (code) => code != null && code < 600,
  ));
  dio.httpClientAdapter = adapter;
  return OctopusApi('http://fake.local', dio: dio);
}
