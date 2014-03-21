require 'yopass/sms_provider'
require 'spec_helper'

describe 'sms_provider' do

  it 'should fail when loading non-existing providers' do
    expect { SmsProvider.create('does_not_exist', {}) }.to raise_error(RuntimeError)
  end

  it 'should work fine to load provider' do
    SmsProvider.create('bulksms', {})
  end
end