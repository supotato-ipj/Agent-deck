# 01: 备份与补丁基础设施

**What to build:** 在触碰壁纸文件之前，建立安全网：对创意工坊中的壁纸目录做全量原始备份，并提供两个一键脚本——"恢复原始状态"与"重放全部改造"。当创意工坊更新覆盖壁纸后，用户能用一条命令重新应用所有定制。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 研究工作目录下存在壁纸原始状态的全量备份
- [x] 恢复脚本能把壁纸目录还原为备份中的原始状态
- [x] 重打补丁脚本能把定制文件覆盖回壁纸目录（本票先建框架，定制文件由后续票补充）
- [x] 两个脚本可重复执行且幂等

## Comments

- 2026-09-20: 备份位于 `backup/original`（7.1M，diff -rq 校验与源一致）；脚本为 `scripts/restore_original.py`（需交互确认）与 `scripts/apply_patch.py`（patched/ 为空时 no-op）。控制台中文乱码为 cp936 显示问题，不影响功能。
