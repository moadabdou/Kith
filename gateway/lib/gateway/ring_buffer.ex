defmodule Gateway.RingBuffer do
  @moduledoc """
  Bounded, sequence-indexed FIFO ring buffer (plan/01 §5–6).
  Maintains in-memory replay history for a session up to a max capacity (default 1000).
  """

  @default_capacity 1000

  defstruct capacity: @default_capacity,
            count: 0,
            min_seq: nil,
            max_seq: nil,
            entries: %{}

  @type t :: %__MODULE__{
          capacity: pos_integer(),
          count: non_neg_integer(),
          min_seq: non_neg_integer() | nil,
          max_seq: non_neg_integer() | nil,
          entries: %{non_neg_integer() => any()}
        }

  @doc """
  Creates a new RingBuffer with given capacity.
  """
  @spec new(pos_integer()) :: t()
  def new(capacity \\ @default_capacity) when is_integer(capacity) and capacity > 0 do
    %__MODULE__{capacity: capacity}
  end

  @doc """
  Appends an item at the given sequence number.
  If capacity is exceeded, drops the oldest sequence item.
  """
  @spec put(t(), non_neg_integer(), any()) :: t()
  def put(%__MODULE__{} = buf, seq, item) when is_integer(seq) do
    if buf.count >= buf.capacity do
      # Evict oldest entry
      evicted_entries = Map.delete(buf.entries, buf.min_seq)

      new_min_seq =
        case Map.keys(evicted_entries) do
          [] -> seq
          keys -> Enum.min(keys)
        end

      %__MODULE__{
        buf
        | entries: Map.put(evicted_entries, seq, item),
          min_seq: min(new_min_seq, seq),
          max_seq: seq
      }
    else
      new_min = if buf.min_seq == nil, do: seq, else: min(buf.min_seq, seq)

      %__MODULE__{
        buf
        | entries: Map.put(buf.entries, seq, item),
          count: buf.count + 1,
          min_seq: new_min,
          max_seq: seq
      }
    end
  end

  @doc """
  Retrieves an item by its sequence number.
  """
  @spec get(t(), non_neg_integer()) :: {:ok, any()} | :error
  def get(%__MODULE__{entries: entries}, seq) when is_integer(seq) do
    Map.fetch(entries, seq)
  end

  @doc """
  Retrieves a contiguous range of items for sequences from `from_seq` to `to_seq` (inclusive).
  Returns `{:ok, [items]}` or `{:error, :gap_unbufferable}` if `from_seq` has already been evicted.
  """
  @spec range(t(), non_neg_integer(), non_neg_integer()) ::
          {:ok, list()} | {:error, :gap_unbufferable}
  def range(%__MODULE__{count: 0}, _from_seq, _to_seq), do: {:ok, []}

  def range(%__MODULE__{} = buf, from_seq, to_seq)
      when is_integer(from_seq) and is_integer(to_seq) do
    cond do
      from_seq > to_seq ->
        {:ok, []}

      from_seq < buf.min_seq ->
        {:error, :gap_unbufferable}

      true ->
        items =
          Enum.reduce_while(from_seq..to_seq, [], fn s, acc ->
            case Map.fetch(buf.entries, s) do
              {:ok, item} -> {:cont, [item | acc]}
              :error -> {:cont, acc}
            end
          end)
          |> Enum.reverse()

        {:ok, items}
    end
  end

  @doc """
  Retrieves a contiguous range of items with sequence numbers from `from_seq` to `to_seq` (inclusive).
  Returns `{:ok, [{seq, item}]}` or `{:error, :gap_unbufferable}` if `from_seq` has already been evicted.
  """
  @spec range_with_seq(t(), non_neg_integer(), non_neg_integer()) ::
          {:ok, list({non_neg_integer(), any()})} | {:error, :gap_unbufferable}
  def range_with_seq(%__MODULE__{count: 0}, _from_seq, _to_seq), do: {:ok, []}

  def range_with_seq(%__MODULE__{} = buf, from_seq, to_seq)
      when is_integer(from_seq) and is_integer(to_seq) do
    cond do
      from_seq > to_seq ->
        {:ok, []}

      from_seq < buf.min_seq ->
        {:error, :gap_unbufferable}

      true ->
        items =
          Enum.reduce_while(from_seq..to_seq, [], fn s, acc ->
            case Map.fetch(buf.entries, s) do
              {:ok, item} -> {:cont, [{s, item} | acc]}
              :error -> {:cont, acc}
            end
          end)
          |> Enum.reverse()

        {:ok, items}
    end
  end

  @doc """
  Returns the number of entries currently stored in the buffer.
  """
  @spec size(t()) :: non_neg_integer()
  def size(%__MODULE__{count: count}), do: count

  @doc """
  Returns true if the buffer has no entries.
  """
  @spec empty?(t()) :: boolean()
  def empty?(%__MODULE__{count: count}), do: count == 0
end
