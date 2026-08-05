import { useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { PromptListItem } from '@aiero/shared';
import { api } from '../lib/api';
import { formatHeat } from '../lib/format';

type StatusFilter = 'all' | 'success' | 'partial';

export function PromptLibraryPage() {
  const { message } = AntApp.useApp();
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [openedAppId, setOpenedAppId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['prompts', search, status, page, pageSize],
    queryFn: () =>
      api.prompts({
        page,
        pageSize,
        keyword: search || undefined,
        status: status === 'all' ? undefined : status,
      }),
  });

  const detail = useQuery({
    queryKey: ['promptDetail', openedAppId],
    queryFn: () => api.promptDetail(openedAppId!),
    enabled: Boolean(openedAppId),
  });

  const latest = detail.data?.[0];

  const copyPrompt = async () => {
    if (!latest) return;
    await navigator.clipboard.writeText(latest.promptText);
    message.success('提示词已复制');
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 360 }}
            placeholder="搜索角色卡名称或提示词正文"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onSearch={(value) => {
              setSearch(value.trim());
              setPage(1);
            }}
            enterButton
          />
          <Segmented<StatusFilter>
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { label: '全部', value: 'all' },
              { label: '完整', value: 'success' },
              { label: '部分', value: 'partial' },
            ]}
          />
        </Space>
      </Card>

      <Card>
        <Table<PromptListItem>
          rowKey="appId"
          size="small"
          loading={list.isLoading}
          dataSource={list.data?.items ?? []}
          onRow={(row) => ({ onClick: () => setOpenedAppId(row.appId) })}
          rowClassName={() => 'clickable-row'}
          pagination={{
            current: page,
            pageSize,
            total: list.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 份提示词`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          columns={[
            { title: '角色卡', dataIndex: 'name', width: 200, ellipsis: true },
            { title: '热度分', dataIndex: 'overallRank', width: 100, render: formatHeat },
            {
              title: '结果',
              dataIndex: 'extractStatus',
              width: 90,
              render: (value: string) =>
                value === 'success' ? <Tag color="green">完整</Tag> : <Tag color="gold">部分</Tag>,
            },
            {
              title: '字数',
              width: 140,
              render: (_, row) =>
                row.expectedLength
                  ? `${row.outputLength} / 标称 ${row.expectedLength}`
                  : String(row.outputLength),
            },
            {
              title: '模型',
              width: 200,
              ellipsis: true,
              render: (_, row) => `${row.modelProvider}/${row.modelName}`,
            },
            { title: '越狱版本', dataIndex: 'promptVersion', width: 90 },
            {
              title: '抽取时间',
              dataIndex: 'extractedAt',
              width: 170,
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            { title: '预览', dataIndex: 'excerpt', ellipsis: true },
          ]}
        />
      </Card>

      <Drawer
        width={760}
        open={Boolean(openedAppId)}
        onClose={() => setOpenedAppId(null)}
        title={latest ? `提示词详情 · ${openedAppId}` : '提示词详情'}
        extra={
          <Button type="primary" onClick={copyPrompt} disabled={!latest}>
            复制全文
          </Button>
        }
      >
        {detail.isLoading ? (
          <Spin />
        ) : !latest ? (
          <Empty description="没有抽取记录" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {latest.modelProvider}/{latest.modelName} · 越狱 {latest.promptVersion} ·{' '}
              {latest.outputLength} 字 · {new Date(latest.extractedAt).toLocaleString('zh-CN')}
            </Typography.Text>
            <div className="prompt-text">{latest.promptText || '（空）'}</div>

            {detail.data && detail.data.length > 1 ? (
              <Typography.Text type="secondary">
                这张卡共有 {detail.data.length} 次抽取记录，上面显示的是最新一次。
              </Typography.Text>
            ) : null}
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
