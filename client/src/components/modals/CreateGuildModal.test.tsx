import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CreateGuildModal } from './CreateGuildModal'

describe('CreateGuildModal', () => {
  it('renders correctly when open', () => {
    const html = renderToStaticMarkup(
      <CreateGuildModal
        isOpen={true}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        currentGuildCount={10}
      />
    )

    expect(html).toContain('Customize your server')
    expect(html).toContain('Server Name')
    expect(html).toContain('Create a Server')
    expect(html).not.toContain('You have reached the maximum limit of 100 servers')
  })

  it('renders limit warning banner when user is in 100 or more guilds', () => {
    const html = renderToStaticMarkup(
      <CreateGuildModal
        isOpen={true}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        currentGuildCount={100}
      />
    )

    expect(html).toContain('You have reached the maximum limit of 100 servers')
    expect(html).toContain('disabled=""')
  })

  it('does not render when isOpen is false', () => {
    const html = renderToStaticMarkup(
      <CreateGuildModal
        isOpen={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
      />
    )

    expect(html).toBe('')
  })
})
