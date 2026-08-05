import { useEffect, useRef, useState } from 'react';
import { Button, Segmented, Select, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { JOB_LOG_LIMITS } from '@aiero/shared';
import { api } from '../lib/api';

const LIVE_POLL_MS = 3000;
/** 离底部这么近就算「贴着底」，继续跟着新日志滚。 */
const STICK_THRESHOLD_PX = 40;

interface JobLogViewerProps {
  jobId: string;
  /** 运行中的任务要轮询；已结束的任务日志不会再变，拉一次就够。 */
  live?: boolean;
  height?: number;
}

/**
 * 任务过程日志。运行中的任务和历史任务共用这一个视图。
 *
 * 一场全量抽取会写出十万条流水，所以不能一次全拉：三个开关（看多少条、只看警告
 * 以上、看开头还是看最新）配起来足够定位问题，也不用做游标翻页——翻页碰上还在
 * 追加的日志会出现空档和重复。
 */
export function JobLogViewer({ jobId, live = false, height = 260 }: JobLogViewerProps) {
  const [limit, setLimit] = useState<number>(JOB_LOG_LIMITS[0]);
  const [warnOnly, setWarnOnly] = useState(false);
  const [fromStart, setFromStart] = useState(false);

  const logs = useQuery({
    queryKey: ['jobLogs', jobId, limit, warnOnly, fromStart],
    queryFn: () => api.jobLogs(jobId, { limit, warnOnly, fromStart }),
    refetchInterval: live ? LIVE_POLL_MS : false,
    // 换开关时先留着上一批，别闪一下空白。
    placeholderData: (previous) => previous,
  });

  const items = logs.data?.items ?? [];
  const total = logs.data?.total ?? 0;

  // 跟着新日志往下滚，但用户手动往上翻的时候不要把他拽回底部。
  const streamRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const node = streamRef.current;
    if (!node || fromStart || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [items, fromStart]);

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={12}>
        <Segmented
          size="small"
          value={warnOnly ? 'warn' : 'all'}
          onChange={(value) => setWarnOnly(value === 'warn')}
          options={[
            { label: '全部', value: 'all' },
            { label: '只看警告和错误', value: 'warn' },
          ]}
        />
        <Segmented
          size="small"
          value={fromStart ? 'start' : 'latest'}
          onChange={(value) => setFromStart(value === 'start')}
          options={[
            { label: '最新', value: 'latest' },
            { label: '任务开头', value: 'start' },
          ]}
        />
        <Select
          size="small"
          value={limit}
          onChange={setLimit}
          style={{ width: 100 }}
          options={JOB_LOG_LIMITS.map((value) => ({ label: `${value} 条`, value }))}
        />
        <Button size="small" loading={logs.isFetching} onClick={() => void logs.refetch()}>
          刷新
        </Button>
        <Typography.Text type="secondary">
          共 {total} 条{total > items.length ? `，这里显示 ${items.length} 条` : ''}
        </Typography.Text>
      </Space>

      <div
        className="log-stream"
        ref={streamRef}
        style={{ height }}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < STICK_THRESHOLD_PX;
        }}
      >
        {logs.isLoading ? (
          <Spin size="small" />
        ) : items.length === 0 ? (
          <div>{emptyHint(warnOnly, live)}</div>
        ) : (
          items.map((entry) => (
            <div key={entry.id} className={`log-${entry.level}`}>
              {new Date(entry.createdAt).toLocaleString('zh-CN')} {entry.message}
            </div>
          ))
        )}
      </div>
    </Space>
  );
}

function emptyHint(warnOnly: boolean, live: boolean): string {
  if (warnOnly) return '这次任务没有警告和错误';
  return live ? '等待日志…' : '这次任务没有留下日志';
}
