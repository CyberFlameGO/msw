import { Headers } from 'headers-polyfill'
import { StrictEventEmitter } from 'strict-event-emitter'
import { ServerLifecycleEventsMap } from '../node/glossary'
import { SharedOptions } from '../sharedOptions'
import { RequestHandler } from '../handlers/RequestHandler'
import { rest } from '../rest'
import { handleRequest, HandleRequestOptions } from './handleRequest'
import { response } from '../response'
import { context, MockedRequest } from '..'
import { RequiredDeep } from '../typeUtils'

const options: RequiredDeep<SharedOptions> = {
  onUnhandledRequest: jest.fn(),
}
const callbacks: Partial<Record<keyof HandleRequestOptions<any>, any>> = {
  onPassthroughResponse: jest.fn(),
  onMockedResponse: jest.fn(),
}

function setup() {
  const emitter = new StrictEventEmitter<ServerLifecycleEventsMap>()
  const listener = jest.fn()

  const createMockListener = (name: string) => {
    return (...args: any) => {
      listener(name, ...args)
    }
  }

  emitter.on('request:start', createMockListener('request:start'))
  emitter.on('request:match', createMockListener('request:match'))
  emitter.on('request:unhandled', createMockListener('request:unhandled'))
  emitter.on('request:end', createMockListener('request:end'))
  emitter.on('response:mocked', createMockListener('response:mocked'))
  emitter.on('response:bypass', createMockListener('response:bypass'))

  const events = listener.mock.calls
  return { emitter, events }
}

beforeEach(() => {
  jest.spyOn(global.console, 'warn').mockImplementation()
})

afterEach(() => {
  jest.resetAllMocks()
})

test('returns undefined for a request with the "x-msw-bypass" header equal to "true"', async () => {
  const { emitter, events } = setup()

  const request = new MockedRequest(new URL('http://localhost/user'), {
    headers: new Headers({
      'x-msw-bypass': 'true',
    }),
  })
  const handlers: Array<RequestHandler> = []

  const result = await handleRequest(
    request,
    handlers,
    options,
    emitter,
    callbacks,
  )

  expect(result).toBeUndefined()
  expect(events).toEqual([
    ['request:start', request],
    ['request:end', request],
  ])
  expect(options.onUnhandledRequest).not.toHaveBeenCalled()
  expect(callbacks.onPassthroughResponse).toHaveBeenNthCalledWith(1, request)
  expect(callbacks.onMockedResponse).not.toHaveBeenCalled()
})

test('does not bypass a request with "x-msw-bypass" header set to arbitrary value', async () => {
  const { emitter } = setup()

  const request = new MockedRequest(new URL('http://localhost/user'), {
    headers: new Headers({
      'x-msw-bypass': 'anything',
    }),
  })
  const handlers: Array<RequestHandler> = [
    rest.get('/user', (req, res, ctx) => {
      return res(ctx.text('hello world'))
    }),
  ]

  const result = await handleRequest(
    request,
    handlers,
    options,
    emitter,
    callbacks,
  )

  expect(result).not.toBeUndefined()
  expect(options.onUnhandledRequest).not.toHaveBeenCalled()
  expect(callbacks.onMockedResponse).toHaveBeenCalledTimes(1)
})

test('reports request as unhandled when it has no matching request handlers', async () => {
  const { emitter, events } = setup()

  const request = new MockedRequest(new URL('http://localhost/user'))
  const handlers: Array<RequestHandler> = []

  const result = await handleRequest(
    request,
    handlers,
    options,
    emitter,
    callbacks,
  )

  expect(result).toBeUndefined()
  expect(events).toEqual([
    ['request:start', request],
    ['request:unhandled', request],
    ['request:end', request],
  ])
  expect(options.onUnhandledRequest).toHaveBeenNthCalledWith(1, request, {
    warning: expect.any(Function),
    error: expect.any(Function),
  })
  expect(callbacks.onPassthroughResponse).toHaveBeenNthCalledWith(1, request)
  expect(callbacks.onMockedResponse).not.toHaveBeenCalled()
})

test('returns undefined and warns on a request handler that returns no response', async () => {
  const { emitter, events } = setup()

  const request = new MockedRequest(new URL('http://localhost/user'))
  const handlers: Array<RequestHandler> = [
    rest.get('/user', () => {
      // Intentionally blank response resolver.
      return
    }),
  ]

  const result = await handleRequest(
    request,
    handlers,
    options,
    emitter,
    callbacks,
  )

  expect(result).toBeUndefined()
  expect(events).toEqual([
    ['request:start', request],
    ['request:end', request],
  ])
  expect(options.onUnhandledRequest).not.toHaveBeenCalled()
  expect(callbacks.onPassthroughResponse).toHaveBeenNthCalledWith(1, request)
  expect(callbacks.onMockedResponse).not.toHaveBeenCalled()

  expect(console.warn).toHaveBeenCalledTimes(1)
  const warning = (console.warn as unknown as jest.SpyInstance).mock.calls[0][0]

  expect(warning).toContain(
    '[MSW] Expected response resolver to return a mocked response Object, but got undefined. The original response is going to be used instead.',
  )
  expect(warning).toContain('GET /user')
  expect(warning).toMatch(/\d+:\d+/)
})

test('returns the mocked response for a request with a matching request handler', async () => {
  const { emitter, events } = setup()

  const request = new MockedRequest(new URL('http://localhost/user'))
  const mockedResponse = await response(context.json({ firstName: 'John' }))
  const handlers: Array<RequestHandler> = [
    rest.get('/user', () => {
      return mockedResponse
    }),
  ]
  const lookupResult = {
    handler: handlers[0],
    response: mockedResponse,
    publicRequest: { ...request, params: {} },
    parsedRequest: { matches: true, params: {} },
  }

  const result = await handleRequest(
    request,
    handlers,
    options,
    emitter,
    callbacks,
  )

  expect(result).toEqual(mockedResponse)
  expect(events).toEqual([
    ['request:start', request],
    ['request:match', request],
    ['request:end', request],
  ])
  expect(callbacks.onPassthroughResponse).not.toHaveBeenCalled()
  expect(callbacks.onMockedResponse).toHaveBeenNthCalledWith(
    1,
    mockedResponse,
    lookupResult,
  )
})

test('returns a transformed response if the "transformResponse" option is provided', async () => {
  const { emitter, events } = setup()

  const request = new MockedRequest(new URL('http://localhost/user'))
  const mockedResponse = await response(context.json({ firstName: 'John' }))
  const handlers: Array<RequestHandler> = [
    rest.get('/user', () => {
      return mockedResponse
    }),
  ]
  const transformResponse = jest.fn().mockImplementation((response) => ({
    body: response.body,
  }))
  const finalResponse = transformResponse(mockedResponse)
  const lookupResult = {
    handler: handlers[0],
    response: mockedResponse,
    publicRequest: { ...request, params: {} },
    parsedRequest: { matches: true, params: {} },
  }

  const result = await handleRequest(request, handlers, options, emitter, {
    ...callbacks,
    transformResponse,
  })

  expect(result).toEqual(finalResponse)
  expect(events).toEqual([
    ['request:start', request],
    ['request:match', request],
    ['request:end', request],
  ])
  expect(callbacks.onPassthroughResponse).not.toHaveBeenCalled()
  expect(transformResponse).toHaveBeenNthCalledWith(1, mockedResponse)
  expect(callbacks.onMockedResponse).toHaveBeenNthCalledWith(
    1,
    finalResponse,
    lookupResult,
  )
})

it('returns undefined without warning on a passthrough request', async () => {
  const { emitter, events } = setup()

  const request = new MockedRequest(new URL('http://localhost/user'))
  const handlers: Array<RequestHandler> = [
    rest.get('/user', (req) => {
      return req.passthrough()
    }),
  ]

  const result = await handleRequest(
    request,
    handlers,
    options,
    emitter,
    callbacks,
  )

  expect(result).toBeUndefined()
  expect(events).toEqual([
    ['request:start', request],
    ['request:end', request],
  ])
  expect(options.onUnhandledRequest).not.toHaveBeenCalled()
  expect(callbacks.onPassthroughResponse).toHaveBeenNthCalledWith(1, request)
  expect(callbacks.onMockedResponse).not.toHaveBeenCalled()
})
