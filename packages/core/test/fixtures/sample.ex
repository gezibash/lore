defmodule Arc.Storage do
  @moduledoc """
  Sample fixture for Elixir parser tests. Copied from ~/Work/arc.
  """

  # def with no parens
  def hello do
    :world
  end

  # def with args
  def greet(name) do
    "Hello, #{name}"
  end

  # def with args and guard
  def decode(str, opts \\ []) when is_binary(str) do
    {:ok, str}
  end

  # defp (private)
  defp normalize_input(str) do
    String.trim(str)
  end

  # defp with guard
  defp validate(x) when is_integer(x) do
    x > 0
  end

  # defmodule nested
  defmodule Helper do
    def run do
      :ok
    end
  end
end

defprotocol Arc.Serializable do
  def serialize(data)
end
