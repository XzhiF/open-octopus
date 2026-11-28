import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

/// 返回：有上一页就退回去，没有就回设备列表 —— 任何页面的「返回」都不该把 App 退掉。
///
/// go_router 的 `pop()` 在栈空时会抛 `There is nothing to pop`（比如深链直接落在
/// 某一页、或历史上被 `go` 压平过），这里兜一层。真正退出 App 只有一条路：
/// 设备列表（栈底）连续返回两次，见 `BackToExit`。
void back(BuildContext context) {
  final router = GoRouter.of(context);
  if (router.canPop()) {
    router.pop();
  } else {
    router.go('/');
  }
}
