import React from 'react'
import { createRoot } from 'react-dom/client'
import { VisualBuilder } from '../../VEE-php/frontend/src/screens/workbench/WorkbenchScreen'
import type { BuilderDocument } from '../../VEE-php/frontend/src/types'
import '../../VEE-php/frontend/src/styles.css'
import { BUILDER_STARTERS } from '../../VEE-php/frontend/src/builder/starter-layouts'

const initial: BuilderDocument = {
  version: 1,
  blocks: [{ id: 'hero-test', type: 'hero', title: 'A real page', body: 'Alpha beta gamma' }],
}
const state = { saved: null as BuilderDocument | null, dirty: false, notices: [] as unknown[] }
const storage = {
  load: async () => structuredClone(initial),
  save: async (_projectId: string, document: BuilderDocument) => { state.saved = structuredClone(document) },
}
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { builderQA: state, startFreshBuilderQA: () => {
  state.saved = null
  root.render(<VisualBuilder key="fresh" selected={{ id: 'fresh-draft', name: 'Fresh draft' }}
    storage={{ load: async () => ({ version: 1, blocks: [], page: { direction: 'ltr' }, seo: { language: 'en' } }), save: storage.save, isNewDocument: () => state.saved === null }}
    initialLayouts={BUILDER_STARTERS} notify={() => {}} setDirtyState={dirty => { state.dirty = dirty }} navigate={() => {}} />)
} })

root.render(<VisualBuilder
  selected={{ id: 'builder-ui-test', name: 'Builder quality check' }}
  storage={storage}
  initialLayouts={BUILDER_STARTERS}
  notify={notice => { state.notices.push(notice) }}
  setDirtyState={dirty => { state.dirty = dirty }}
  navigate={() => {}}
/>)
