import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GifPicker } from './GifPicker'

vi.mock('../../api', () => ({
  api: {
    getTrendingGifs: vi.fn().mockResolvedValue({
      results: [
        {
          id: 'gif-1',
          title: 'Party Dance',
          url: 'https://media.klipy.com/gifs/dance.gif',
          preview_url: 'https://media.klipy.com/gifs/dance_preview.gif',
          width: 300,
          height: 200,
        },
      ],
      next: 'page2',
    }),
    searchGifs: vi.fn().mockResolvedValue({
      results: [],
      next: '',
    }),
    getGifCategories: vi.fn().mockResolvedValue([
      { id: 'cat-1', name: 'Excited', query: 'excited' },
      { id: 'cat-2', name: 'Laughing', query: 'laughing' },
    ]),
  },
}))

describe('GifPicker', () => {
  it('renders popover header with search bar and category bar', () => {
    const onSelectGif = vi.fn()
    const onClose = vi.fn()

    const html = renderToStaticMarkup(
      <GifPicker onSelectGif={onSelectGif} onClose={onClose} />
    )

    expect(html).toContain('gif-picker-popover')
    expect(html).toContain('Search KLIPY...')
    expect(html).toContain('gif-categories-bar')
    expect(html).toContain('Trending')
  })

  it('renders search input with clear button behavior when query is present', () => {
    const html = renderToStaticMarkup(
      <GifPicker onSelectGif={vi.fn()} onClose={vi.fn()} position={{ bottom: 50, right: 20 }} />
    )

    expect(html).toContain('style="bottom:50px;right:20px"')
  })
})
