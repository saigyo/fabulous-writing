// Mock localStorage if not available
const mockStorage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, value: string) => { mockStorage[key] = value },
  removeItem: (key: string) => { delete mockStorage[key] },
  clear: () => { Object.keys(mockStorage).forEach(key => delete mockStorage[key]) },
  key: (index: number) => Object.keys(mockStorage)[index] || null,
  get length() { return Object.keys(mockStorage).length },
}

if (typeof global !== 'undefined' && !global.localStorage) {
  global.localStorage = localStorageMock as any
}
