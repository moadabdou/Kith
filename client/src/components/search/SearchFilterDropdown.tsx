import { useState, useRef, useEffect } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface FilterOption {
  value: string
  label: string
  sublabel?: string
  icon?: React.ReactNode
}

interface SearchFilterDropdownProps {
  icon: React.ReactNode
  value: string
  placeholder: string
  options: FilterOption[]
  onChange: (value: string) => void
  title?: string
}

export function SearchFilterDropdown({
  icon,
  value,
  placeholder,
  options,
  onChange,
  title,
}: SearchFilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [filterText, setFilterText] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find((opt) => opt.value === value)
  const displayLabel = selectedOption ? selectedOption.label : placeholder

  useEffect(() => {
    if (!isOpen) {
      setFilterText('')
      return
    }

    const handlePointerDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const filteredOptions = filterText.trim()
    ? options.filter((opt) =>
        opt.label.toLowerCase().includes(filterText.toLowerCase()) ||
        (opt.sublabel && opt.sublabel.toLowerCase().includes(filterText.toLowerCase()))
      )
    : options

  return (
    <div className="custom-dropdown-container" ref={dropdownRef} title={title}>
      <button
        type="button"
        className={`custom-dropdown-trigger ${isOpen ? 'active' : ''} ${value ? 'has-value' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="custom-dropdown-icon">{icon}</span>
        <span className="custom-dropdown-label">{displayLabel}</span>
        <ChevronDown
          size={14}
          className={`custom-dropdown-chevron ${isOpen ? 'open' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="custom-dropdown-menu" role="listbox">
          {options.length > 5 && (
            <div className="custom-dropdown-search-wrap">
              <input
                type="text"
                className="custom-dropdown-search-input"
                placeholder="Filter..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                autoFocus
              />
            </div>
          )}
          {filteredOptions.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
              No matches found
            </div>
          ) : (
            filteredOptions.map((opt) => {
              const isSelected = opt.value === value
              return (
                <button
                  type="button"
                  key={opt.value}
                  className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    onChange(opt.value)
                    setIsOpen(false)
                  }}
                  role="option"
                  aria-selected={isSelected}
                >
                  {opt.icon && <span className="custom-dropdown-item-icon">{opt.icon}</span>}
                  <span className="custom-dropdown-item-text">{opt.label}</span>
                  {opt.sublabel && (
                    <span className="custom-dropdown-sublabel">{opt.sublabel}</span>
                  )}
                  {isSelected && <Check size={14} className="custom-dropdown-check" />}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
