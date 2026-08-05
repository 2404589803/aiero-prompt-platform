import { useMemo, useState } from 'react';
import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { AvailableModel } from '@aiero/shared';
import { api } from '../lib/api';

/**
 * 风月当前可用的模型清单。
 *
 * 现拉不缓存：清单是风月那边随时会变的东西，存一份下来只会让人对着过期名单排查。
 * 代价是每次要借一个账号登录，所以默认不自动拉，点了按钮才去。
 */
export function ModelListPage() {
  const [loaded, setLoaded] = useState(false);
  const [keyword, setKeyword] = useState('');

  const models = useQuery({
    queryKey: ['models'],
    queryFn: api.models,
    enabled: loaded,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const items = models.data ?? [];
  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) || item.provider.toLowerCase().includes(needle)
    );
  }, [items, keyword]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="这就是抽取时逐个尝试的顺序"
        description={
          '任务参数里模型留「自动」时，会在启动那一刻拉一次这份清单，' +
          '并按「优先模型 → 同名优先模型 → 风月标的推荐 → 成功率降序」排好。' +
          '一张卡会按这个顺序试「模型 × 越狱提示词」的每一组，任一组套出提示词就收工；' +
          '某个模型触发限流时会跳过它剩下的提示词版本，直接换下一个模型。'
        }
      />

      <Card
        title="风月可用模型"
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="按供应商或模型名筛选"
              style={{ width: 240 }}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button
              type="primary"
              loading={models.isFetching}
              onClick={() => {
                if (!loaded) setLoaded(true);
                else void models.refetch();
              }}
            >
              {loaded ? '重新拉取' : '拉取清单'}
            </Button>
          </Space>
        }
      >
        {models.isError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message="拉取失败"
            description={(models.error as Error).message}
          />
        ) : null}

        {!loaded ? (
          <Typography.Text type="secondary">
            拉取清单要借账号池里的一个账号登录风月，所以不自动加载，点右上角按钮取一次。
          </Typography.Text>
        ) : (
          <Table
            rowKey={(row) => `${row.provider}/${row.name}`}
            size="small"
            loading={models.isLoading}
            dataSource={filtered}
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (n) => `共 ${n} 个` }}
            columns={[
              {
                title: '尝试顺序',
                width: 90,
                render: (_, row: AvailableModel) => items.indexOf(row) + 1,
              },
              { title: '供应商', dataIndex: 'provider', width: 200 },
              { title: '模型', dataIndex: 'name' },
              {
                title: '标记',
                width: 160,
                render: (_, row: AvailableModel) => (
                  <Space size={4}>
                    {row.priority ? <Tag color="green">优先</Tag> : null}
                    {row.recommended ? <Tag color="blue">风月推荐</Tag> : null}
                  </Space>
                ),
              },
              {
                title: '成功率',
                width: 100,
                render: (_, row: AvailableModel) =>
                  row.successRate === null ? '—' : row.successRate,
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
