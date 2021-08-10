import { combineReducers } from 'redux'

import oidcReducer from './oidc'

export const rootReducer = combineReducers({
  oidc: oidcReducer,
})

export type RootState = ReturnType<typeof rootReducer>
