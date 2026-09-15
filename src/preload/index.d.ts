import type { SecretaryApi } from '../shared/types'

declare global {
  interface Window {
    api: SecretaryApi
  }
}
export {}
