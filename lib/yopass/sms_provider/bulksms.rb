require 'open-uri'

class Bulksms
  def initialize(settings)
    @api_url = 'http://bulksms.vsms.net:5567/eapi/submission/send_sms/2/2.0'
    @username = settings['username']
    @password = settings['password']
    @sender = settings['sender']
  end

  def send(to, message)
    url = URI.join(@api_url, "?username=#{@username}&password=#{@password}" \
                   "&message=#{message}&msisdn=#{to}&sender=#{@sender}")
    result = open(url, options).read
    return true if result.include? 'IN_PROGRESS'
    false
  end

  def options
    opts = {}
    url = ENV['YP_OUTBOUND_PROXY']
    opts[:proxy] = URI.parse(url) unless url.nil?
  end
end
