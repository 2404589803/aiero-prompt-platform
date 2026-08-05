import { useState } from 'react';
import { App as AntApp, Button, Card, Input, Select, Space, Table, Tag, Tooltip } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSummary, ExtractStatus } from '@aiero/shared';
import { api } from '../lib/api';
import { formatHeat } from '../lib/format';

const STATUS_META: Record<ExtractStatus, { label: string; color: string }> = {
  pending: { label: '待抽取', color: 'default' },
  running: { label: '抽取中', color: 'processing' },
  success: { label: '完整', color: 'green' },
  partial: { label: '部分', color: 'gold' },
  failed: { label: '失败', color: 'red' },
};

export function AppsPage() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ExtractStatus | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const list = useQuery({
    queryKey: ['apps', search, status, page, pageSize],
    queryFn: () => api.apps({ page, pageSize, keyword: search || undefined, status }),
  });

  const reset = useMutation({
    mutationFn: (appId: string) => api.resetApp(appId),
    onSuccess: () => {
      message.success('已放回待抽取队列');
      void queryClient.invalidateQueries({ queryKey: ['apps'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 320 }}
            placeholder="搜索角色卡名称或 ID"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onSearch={(value) => {
              setSearch(value.trim());
              setPage(1);
            }}
            enterButton
          />
          <Select<ExtractStatus | undefined>
            allowClear
            placeholder="全部状态"
            style={{ width: 160 }}
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={Object.entries(STATUS_META).map(([value, meta]) => ({
              value: value as ExtractStatus,
              label: meta.label,
            }))}
          />
        </Space>
      </Card>

      <Card>
        <Table<AppSummary>
          rowKey="appId"
          size="small"
          loading={list.isLoading}
          dataSource={list.data?.items ?? []}
          pagination={{
            current: page,
            pageSize,
            total: list.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 张角色卡`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          columns={[
            { title: '角色卡', dataIndex: 'name', width: 220, ellipsis: true },
            {
              title: '热度分',
              dataIndex: 'overallRank',
              width: 130,
              render: formatHeat,
            },
            { title: '作者', dataIndex: 'accountName', width: 140, ellipsis: true },
            {
              title: '标称提示词长度',
              dataIndex: 'prePromptLength',
              width: 130,
              render: (value: number | null) => value ?? '—',
            },
            {
              title: '状态',
              dataIndex: 'extractStatus',
              width: 100,
              render: (value: ExtractStatus) => (
                <Tag color={STATUS_META[value].color}>{STATUS_META[value].label}</Tag>
              ),
            },
            { title: '尝试次数', dataIndex: 'attempts', width: 90 },
            {
              title: '最近错误',
              dataIndex: 'lastError',
              ellipsis: true,
              render: (value: string | null) =>
                value ? (
                  <Tooltip title={value}>
                    <span>{value}</span>
                  </Tooltip>
                ) : (
                  '—'
                ),
            },
            {
              title: '操作',
              width: 90,
              render: (_, row) => (
                <Button
                  size="small"
                  disabled={row.extractStatus === 'pending' || row.extractStatus === 'running'}
                  loading={reset.isPending && reset.variables === row.appId}
                  onClick={() => reset.mutate(row.appId)}
                >
                  重抽
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
