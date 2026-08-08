import {
  type MarketplaceFetch,
  type MarketplaceFetchResponse,
  type McpMarketplaceErrorCode,
  McpMarketplaceService
} from '../McpMarketplaceService'

const jsonResponse = (body: unknown, status = 200): MarketplaceFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: jest.fn().mockResolvedValue(JSON.stringify(body))
})

const textResponse = (body: string, status = 200): MarketplaceFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: jest.fn().mockResolvedValue(body)
})

describe('McpMarketplaceService', () => {
  let fetchMock: jest.MockedFunction<MarketplaceFetch>
  let service: McpMarketplaceService

  beforeEach(() => {
    fetchMock = jest.fn()
    service = new McpMarketplaceService(fetchMock)
  })

  it('searches the ModelScope marketplace with a bounded public query and maps its result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          total_count: 50,
          mcp_server_list: [
            {
              id: '@amap/amap-maps',
              chinese_name: '高德地图',
              description: '地图能力',
              logo_url: 'https://cdn.example.com/amap.png',
              tags: ['地图'],
              categories: ['location-services'],
              view_count: 123,
              is_verified: true
            }
          ]
        }
      })
    )

    const result = await service.searchModelScope({ query: '地图', page: 2, pageSize: 500 })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://modelscope.cn/openapi/v1/mcp/servers',
      expect.objectContaining({ method: 'PUT' })
    )
    const request = fetchMock.mock.calls[0][1]
    expect(JSON.parse(request?.body as string)).toEqual({
      page_number: 2,
      page_size: 100,
      search: '地图',
      filter: { is_hosted: true }
    })
    expect(result).toEqual({
      servers: [
        expect.objectContaining({
          marketplace: 'modelscope',
          id: '@amap/amap-maps',
          name: '高德地图',
          tags: ['地图', 'location-services'],
          popularity: 123,
          isVerified: true
        })
      ],
      totalCount: 50,
      page: 2,
      pageSize: 100
    })
  })

  it('reads ModelScope hosted and configuration metadata before allowing a deployment', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          id: '@amap/amap-maps',
          name: '高德地图',
          is_hosted: true,
          is_verified: true,
          env_schema: {
            type: 'object',
            properties: {
              AMAP_MAPS_API_KEY: { type: 'string', description: '高德 Key' },
              REGION: { type: 'string' }
            },
            required: ['AMAP_MAPS_API_KEY']
          }
        }
      })
    )

    const detail = await service.getModelScopeServer('@amap/amap-maps')

    expect(fetchMock.mock.calls[0][0]).toBe('https://modelscope.cn/openapi/v1/mcp/servers/%40amap%2Famap-maps')
    expect(detail.canDeploy).toBe(true)
    expect(detail.configuration).toEqual([
      {
        key: 'AMAP_MAPS_API_KEY',
        description: '高德 Key',
        required: true,
        sensitive: true
      },
      {
        key: 'REGION',
        description: undefined,
        required: false,
        sensitive: false
      }
    ])
  })

  it('deploys a ModelScope server as Streamable HTTP without persisting its access token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          url: 'https://mcp.modelscope.example/session/mcp',
          transport_type: 'streamable_http',
          auth_required: false
        }
      })
    )

    const deployment = await service.deployModelScopeServer('@amap/amap-maps', '  ms-secret-token  ', {
      AMAP_MAPS_API_KEY: ' amap-key ',
      EMPTY: ' '
    })

    const request = fetchMock.mock.calls[0][1]
    expect(request?.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer ms-secret-token',
        'Content-Type': 'application/json'
      })
    )
    expect(JSON.parse(request?.body as string)).toEqual({
      transport_type: 'streamable_http',
      expiration_minutes: -1,
      env_info: { AMAP_MAPS_API_KEY: 'amap-key' }
    })
    expect(deployment).toEqual({
      endpoint: 'https://mcp.modelscope.example/session/mcp',
      authRequired: false
    })
  })

  it('browses the public official registry without a marketplace credential and filters non-mobile transports', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        servers: [
          {
            server: {
              name: 'io.example/weather',
              title: 'Weather',
              description: 'Forecasts',
              icons: [{ src: 'https://cdn.example.com/weather.png' }],
              _meta: {
                'io.modelcontextprotocol.registry/publisher-provided': {
                  categories: ['Weather'],
                  keywords: ['forecast']
                }
              },
              remotes: [{ type: 'stdio' }, { type: 'streamable-http', url: 'https://weather.example.com/mcp' }]
            }
          },
          {
            server: {
              name: 'io.example/local',
              title: 'Local only',
              remotes: [{ type: 'stdio' }]
            }
          }
        ],
        metadata: { nextCursor: 'io.example/weather:1.0.0', count: 2 }
      })
    )

    const result = await service.searchOfficialRegistry({ query: 'weather', cursor: 'cursor-1', pageSize: 500 })

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100&search=weather&cursor=cursor-1'
    )
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' })
    expect(result).toEqual({
      servers: [
        expect.objectContaining({
          marketplace: 'registry',
          id: 'io.example/weather',
          name: 'Weather',
          tags: ['Weather', 'forecast'],
          isRemoteReady: true
        })
      ],
      totalCount: 1,
      page: 1,
      pageSize: 100,
      nextCursor: 'io.example/weather:1.0.0'
    })
  })

  it('resolves official Registry URL templates and required headers into a mobile MCP record', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        server: {
          name: 'io.example/weather',
          title: 'Weather',
          description: 'Forecasts',
          remotes: [
            {
              type: 'streamable-http',
              url: 'https://{region}.example.com/mcp?tenant={tenant_id}',
              variables: {
                region: { isRequired: true, description: 'Deployment region' },
                tenant_id: { default: 'team default', description: 'Tenant name' },
                client_id: { value: 'cherry-mobile' }
              },
              headers: [
                {
                  name: 'Authorization',
                  value: 'Bearer {api_key}',
                  isRequired: true,
                  isSecret: true,
                  variables: {
                    api_key: { isRequired: true, isSecret: true, description: 'Service API key' }
                  }
                },
                { name: 'X-Client-ID', value: '{client_id}', isRequired: true },
                { name: 'X-Mode', isRequired: true, default: 'mobile' },
                { name: 'X-Optional', description: 'Optional account hint' }
              ]
            }
          ]
        }
      })
    )

    const detail = await service.getOfficialRegistryServer('io.example/weather')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fweather/versions/latest'
    )
    expect(detail).toEqual(
      expect.objectContaining({
        marketplace: 'registry',
        canDeploy: false,
        endpoint: undefined,
        isRemoteReady: true
      })
    )
    expect(detail.configuration).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'url:region', label: 'region', required: true }),
        expect.objectContaining({ key: 'url:tenant_id', defaultValue: 'team default', required: true }),
        expect.objectContaining({ key: 'header:0:variable:api_key', sensitive: true, required: true }),
        expect.objectContaining({ key: 'header:2:X-Mode', defaultValue: 'mobile', required: true })
      ])
    )

    const connection = service.createRemoteConnection(detail, {
      'url:region': 'us-west',
      'header:0:variable:api_key': 'service-secret'
    })
    expect(connection).toEqual({
      endpoint: 'https://us-west.example.com/mcp?tenant=team%20default',
      headers: {
        Authorization: 'Bearer service-secret',
        'X-Client-ID': 'cherry-mobile',
        'X-Mode': 'mobile'
      }
    })

    const mcp = service.toMcpServer(detail, connection, {
      idFactory: () => 'marketplace-id',
      now: () => 1234
    })
    expect(mcp).toEqual(
      expect.objectContaining({
        id: 'marketplace-id',
        name: 'Weather',
        type: 'streamableHttp',
        baseUrl: 'https://us-west.example.com/mcp?tenant=team%20default',
        headers: connection.headers,
        provider: 'Official MCP Registry',
        isActive: true,
        installedAt: 1234
      })
    )
  })

  it('refuses unsafe registry endpoints and malformed required configuration', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        server: {
          name: 'io.example/unsafe',
          remotes: [{ type: 'streamable-http', url: 'http://unsafe.example/mcp' }]
        }
      })
    )

    const unsafeDetail = await service.getOfficialRegistryServer('io.example/unsafe')
    expect(unsafeDetail.remote).toBeUndefined()

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        server: {
          name: 'io.example/header',
          remotes: [
            {
              type: 'streamable-http',
              url: 'https://safe.example/mcp',
              headers: [{ name: 'Authorization', isRequired: true, isSecret: true }]
            }
          ]
        }
      })
    )
    const headerDetail = await service.getOfficialRegistryServer('io.example/header')
    let configurationError: unknown
    try {
      service.createRemoteConnection(headerDetail, { 'header:0:Authorization': 'Bearer safe\r\nInjected: value' })
    } catch (error) {
      configurationError = error
    }
    expect(configurationError).toEqual(expect.objectContaining({ code: 'CONFIGURATION_REQUIRED' }))
  })

  it.each<[string, unknown, McpMarketplaceErrorCode, number?]>([
    ['maps registry authentication failures', { error: 'denied' }, 'UNAUTHORIZED', 401],
    ['rejects a malformed JSON body', 'not-json', 'INVALID_RESPONSE']
  ])('%s', async (_label, body, code, status = 200) => {
    fetchMock.mockResolvedValueOnce(typeof body === 'string' ? textResponse(body, status) : jsonResponse(body, status))

    await expect(service.searchOfficialRegistry()).rejects.toEqual(expect.objectContaining({ code }))
  })
})
