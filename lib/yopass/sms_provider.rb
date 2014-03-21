class SmsProvider
  def self.create(provider, settings)
    begin
      require "yopass/sms_provider/#{provider.downcase}"
    rescue LoadError => e
      raise "Unsupported provider #{provider}: #{e}"
    end
    class_name = provider.split('_').map { |v| v.capitalize }.join
    const_get(class_name).new settings
  end
end
