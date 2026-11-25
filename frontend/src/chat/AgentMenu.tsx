/**
 * What answers in this session: which model, and how hard it thinks.
 *
 * One button in the composer says the choice; its menu changes it. The choice
 * belongs to the session, so a quick question can go to a small model in one
 * tab while a long piece of work runs on a large one in another. Left alone,
 * a session uses what the project is set up with. A change takes effect with
 * the next message: a reply already under way finishes as it started.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import type { AgentStatus } from '../api'

export interface AgentChoice {
  model: string | null
  effort: string | null
}

/** What the button says: the choice, or that there is none. */
export function choiceLabel(choice: AgentChoice): string {
  if (choice.model === null && choice.effort === null) return 'Default model'
  return `${choice.model ?? 'default'} · ${choice.effort ?? 'default'}`
}

export interface AgentMenuProps {
  agent: AgentStatus
  choice: AgentChoice
  onChoice: (choice: AgentChoice) => void
}

export function AgentMenu(props: AgentMenuProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)
  const models = props.agent.models ?? []
  const efforts = props.agent.efforts ?? []
  const { model, effort } = props.choice

  // Click-away and Escape close it, as any menu does.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A backend with nothing to choose between has no use for the button.
  if (models.length === 0 && efforts.length === 0) return null

  const choose = (next: AgentChoice): void => {
    setOpen(false)
    if (next.model !== model || next.effort !== effort) props.onChoice(next)
  }

  const option = (label: string, chosen: boolean, pick: () => void, key = label) => (
    <button
      key={key}
      type="button"
      class={chosen ? 'menu-item agent-option on' : 'menu-item agent-option'}
      role="menuitemradio"
      aria-checked={chosen}
      onClick={pick}
    >
      <span class="agent-tick" aria-hidden="true">
        {chosen ? '✓' : ''}
      </span>
      {label}
    </button>
  )

  const withDefault = (value: string | null | undefined): string =>
    value ? `Default (${value})` : 'Default'
  // A model named by hand stays in the list while it is the one in use.
  const custom = model !== null && !models.includes(model) ? model : null

  return (
    <div class="agent-wrap" ref={wrap}>
      <button
        type="button"
        class={open ? 'agent-button on' : 'agent-button'}
        data-setting="agent"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Model: ${model ?? 'default'} — effort: ${effort ?? 'default'}. Applies from the next message in this session.`}
        onClick={() => setOpen(!open)}
      >
        {choiceLabel(props.choice)}
        <span class="conv-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div class="agent-menu" role="menu">
          <div class="menu-kicker">Model</div>
          {option(withDefault(props.agent.default_model), model === null, () =>
            choose({ model: null, effort }),
          )}
          {models.map((name) =>
            option(name, model === name, () => choose({ model: name, effort })),
          )}
          {custom !== null && option(custom, true, () => setOpen(false))}
          {option(
            'Other…',
            false,
            () => {
              const typed = window.prompt('Model name or ID', custom ?? '')?.trim()
              if (typed) choose({ model: typed, effort })
              else setOpen(false)
            },
            'other',
          )}

          {efforts.length > 0 && (
            <>
              <div class="menu-section">Effort</div>
              {option(
                withDefault(props.agent.default_effort),
                effort === null,
                () => choose({ model, effort: null }),
                'default-effort',
              )}
              {efforts.map((level) =>
                option(level, effort === level, () => choose({ model, effort: level })),
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
