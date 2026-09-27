-- P1 单引擎初始化（仅数据卷首建时执行）
-- 顺序有坑：pg_search 0.25.x 依赖 vector，装反会 ERROR "required extension
-- vector is not installed" 且 initdb 失败后重启会静默跳过 initdb.d（需重建卷）。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search CASCADE;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 测试 harness 的 template 库（计划交付物：template 库 + 每例事务回滚）。
-- 迁移器/fixture 把 schema 灌进此库，测试 CREATE DATABASE ... TEMPLATE 后开事务跑完回滚，
-- 单例可独立跑、不靠执行顺序。
CREATE DATABASE octopus_template TEMPLATE octopus;
