import type { InputHTMLAttributes, RefObject } from 'react';
import { ClearIcon, SearchIcon } from './icons';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  input: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery(query: string): void;
  onSubmitted?(): void;
}

export default function SearchField({ input, query, onQuery, onSubmitted, ...more }: Props) {
  return (
    <form className="ex-search-field" role="search" onSubmit={e => { e.preventDefault(); onSubmitted?.(); }}>
      <SearchIcon />
      <input ref={input} type="search" aria-label="Search places" autoComplete="off" spellCheck={false} value={query} onChange={e => onQuery(e.target.value)} {...more} />
      {query && (
        <button type="button" className="ex-search-clear" aria-label="Clear search" onClick={() => { onQuery(''); input.current?.focus(); }}>
          <ClearIcon />
        </button>
      )}
    </form>
  );
}
