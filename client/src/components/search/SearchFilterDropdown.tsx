import { useState, useRef, useEffect } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface FilterOption {
  value: string
  label: string
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
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find((opt) => opt.value === value)
  const displayLabel = selectedOption ? selectedOption.label : placeholder

  useEffect(() => {
    if (!isOpen) return

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
          {options.map((opt) => {
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
                {isSelected && <Check size={14} className="custom-dropdown-check" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
