import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { SpotlightView } from './SpotlightView'

const baseParticipants = [
  {
    userId: 'alice',
    displayName: 'Alice',
    isSelf: false,
    stream: null,
    speaking: false,
  },
  {
    userId: 'bob',
    displayName: 'Bob',
    isSelf: false,
    stream: null,
    speaking: false,
  },
]

describe('SpotlightView (manual spotlight, never automatic)', () => {
  it("renders the spotlighted camera with a back-to-grid control", () => {
    const html = renderToString(
      <SpotlightView
        spotlight={{ userId: 'alice', displayName: 'Alice', isSelf: false, stream: null, kind: 'camera' }}
        participants={baseParticipants}
        onBackToGrid={() => {}}
      />
    )

    expect(html).toContain("Alice&#x27;s Camera")
    expect(html).toContain('Back to grid')
    expect(html).not.toContain('Stop Sharing')
  })

  it('renders screen title and stop control only for self screen shares', () => {
    const html = renderToString(
      <SpotlightView
        spotlight={{ userId: 'me', displayName: 'Me', isSelf: true, stream: null, kind: 'screen' }}
        participants={[]}
        onBackToGrid={() => {}}
        onStopScreenShare={() => {}}
      />
    )

    expect(html).toContain('You are sharing your screen')
    expect(html).toContain('Stop Sharing')
  })

  it('shows avatar fallback when the spotlighted user publishes nothing', () => {
    const html = renderToString(
      <SpotlightView
        spotlight={{ userId: 'bob', displayName: 'Bob', isSelf: false, stream: null, kind: 'camera' }}
        participants={baseParticipants}
        onBackToGrid={() => {}}
      />
    )

    expect(html).toContain('No video')
    expect(html).toContain('BO')
  })

  it('renders the resolved quality label and layer pill', () => {
    const html = renderToString(
      <SpotlightView
        spotlight={{
          userId: 'alice',
          displayName: 'Alice',
          isSelf: false,
          stream: null,
          kind: 'camera',
          qualityLabel: '360p',
          qualityLayer: 'h',
          qualityDetail: '360p • 15fps',
        }}
        participants={baseParticipants}
        onBackToGrid={() => {}}
      />,
    )

    expect(html).toContain('360p • 15fps')
    expect(html).toContain('>h<')
  })

  it('excludes the spotlighted user from the filmstrip', () => {
    const html = renderToString(
      <SpotlightView
        spotlight={{ userId: 'alice', displayName: 'Alice', isSelf: false, stream: null, kind: 'screen' }}
        participants={baseParticipants}
        onBackToGrid={() => {}}
      />
    )

    expect(html).toContain("Alice&#x27;s Screen")
    // Bob remains in the filmstrip; Alice appears only in the spotlight.
    expect(html).toContain('Bob')
    expect(html).not.toContain('screenshare-filmstrip-item"><div class="video-tile" data-user-id="alice"')
  })
})
